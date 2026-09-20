# HopWatch Design Spec

Status: **approved and built.** This document is the original architecture spec; the product
is implemented. It has since been extended beyond the original passive/read-only design by the
**v2.0 additions**: an opt-in transmit (TX) subsystem, role-based access control (RBAC), owned
nodes, and Discord SSO. Where this spec says "passive observer only," "read-only," or "nothing
can publish to the mesh," read it as the original phase-1 posture, now superseded by the
opt-in, off-by-default TX subsystem. See `docs/tx.md`, `docs/config.md`, and the README for the
current surface; `CLAUDE.md` Rules 1 and 2 are authoritative.

## 0. Tech stack (locked by the user)

| Concern | Choice | Consequences captured in this spec |
|---|---|---|
| Web framework | **Next.js (App Router)** | UI + REST API served by one Next process; ingest and jobs are separate Node processes. |
| UI primitives | **Radix UI** | Accessible, unstyled primitives (dialogs, popovers, tabs, tooltips, dropdowns). |
| Styling | **Tailwind CSS** | Utility classes; role/quality color tokens defined once in the Tailwind theme and reused across map, graph, and tables. |
| Database | **MySQL 8 (InnoDB, utf8mb4)** | RANGE partitioning with partition-key-in-every-unique-key; no FKs on partitioned tables; no `LISTEN/NOTIFY`; worker-driven rollups. |
| Email | **SMTP** (nodemailer) | Alert + digest delivery. |
| Calendar | **`ical-generator`** | `.ics` event feed and digest attachments (new nodes, records, propagation events, alerts). |

Deviations from the original design prompt (which assumed PostgreSQL): every place the prompt says PostgreSQL, HopWatch uses **MySQL 8** as the primary store. SQLite remains available only as an explicit small-deployment mode behind the same repository interface. All MySQL-specific accommodations are called out inline below.

### Recommended supporting libraries (implementation choices, not locked)

- **Data access:** Kysely or Drizzle (typed SQL over `mysql2`). Prisma is *not* recommended here because it does not model native partitioning or raw partition DDL well.
- **Migrations:** plain versioned SQL files applied by a `migrate` step on startup (partition DDL is hand-written; ORM migration generators cannot express it).
- **MQTT:** `mqtt` (mqtt.js).
- **Protobuf:** `@meshtastic/protobufs` or `protobufjs`/`ts-proto` generated from the Meshtastic `.proto` set (`ServiceEnvelope`, `MeshPacket`, `Data`, `Position`, `Telemetry`, `NodeInfo`, `RouteDiscovery`).
- **Charts:** `uPlot` for dense telemetry/RSSI time series (handles 100k+ points), Recharts for simple bar/line panels.
- **Map:** MapLibre GL or Leaflet with a config-driven raster tile provider.
- **Admin auth:** Auth.js (credentials) or `iron-session` cookie session; bearer tokens for API.

---

## 1. Scope and guiding principles

HopWatch is a self-hosted Meshtastic mesh observatory that ingests MQTT traffic from one or more brokers, stores packet and reception data durably, and serves a web UI and versioned API for analysis. It replaces Malla and is designed to fix Malla's known weaknesses, not merely reproduce its features.

### Core architectural decision: receptions, not packets

A single mesh packet may be uplinked by many MQTT gateways. HopWatch must **not** collapse those into duplicates. The core model is:

- **Packet:** one logical mesh packet, identified by mesh packet id + sender node id + a coarse dedup window.
- **Reception:** one gateway-specific copy of that packet, carrying gateway id, RSSI, SNR, receive time, hop metadata, relay byte, raw topic, and source broker.

Every major analytic feature is built on receptions: gateway coverage, gateway comparison, direct-heard attribution, link quality/asymmetry, propagation, and coverage analysis.

### Design goals

- **Passive by default** (originally "passive observer only"). Out of the box the system publishes nothing to the mesh; every outbound integration (APRS-IS, digests) is one-way and off by default. The v2.0 TX subsystem adds an opt-in path to publish, but only when explicitly enabled, armed by an admin, and inside rate/channel-util limits, with every send audited (see `docs/tx.md`). A fresh install still transmits nothing.
- **Config, not code.** Topics, keys, retention, alert rules, tile provider, and branding are all config-driven; no source edits required to change behavior.
- **Scale.** Dashboard counters read from rollups, never full-table scans; the UI stays fast at 100M+ reception rows.
- **Re-decodability.** Raw encrypted payloads for undecryptable packets are retained so they can be re-decoded when a channel key is added later.
- **Restart-safe idempotent ingest.** Ingest and jobs are separate processes communicating only through the database; both survive restarts without duplicate writes.
- **UTC everywhere, rendered local.** All stored datetimes are UTC; the UI renders a config-set local timezone. No naive datetime handling.

### Working assumptions (pending confirmation)

The user confirmed **~2000 nodes heard on average** (regional scale) and delegated the rest. Decisions:

1. **Scale: regional, ~2000 nodes.** Sizing estimate: ~2000 nodes × ~20 pkts/hr × ~3-5 gateway copies ≈ **2-5M receptions/day → ~200-450M rows** at the 90-day decoded retention. This is past the prompt's 100M target, so:
   - Partitions are **daily** (each `receptions` partition ~2-5M rows - the right size; weekly would bloat partitions to 15-35M and blunt retention). Secondary indexes are **local per-partition** in MySQL, so time-ranged queries prune to a bounded index. Confirmed, not assumed.
   - Ingest runs as a single process by default but must **batch/pipeline inserts** (multi-row `INSERT`, ~30-60 receptions/s average, higher peaks). A scale-out path (N ingest workers + DB-unique-index dedup instead of the in-process LRU) is documented in §2.
   - The high-cardinality **`reception_rollup_hour` (gateway×node×hour)** is retained long-but-configurable (default 365d), **not** indefinite - see §3. All low-cardinality rollups (node/gateway/mesh, hourly and daily) and every `*_day` rollup remain indefinite as the prompt requires.
2. **Brokers:** multi-broker config supported from day one; a single-broker deployment is the common starting case.
3. **Storage engine:** MySQL primary from the first release; SQLite small-mode scaffolded behind the repository interface but not a supported target at 2000-node scale.

---

## 2. Architecture overview

### Processes

HopWatch runs as **four roles**. In a small deployment `ingest` and `worker` may run in one process; at scale they are separate containers.

1. **`web` - Next.js (App Router) app**
   - Serves the UI (React Server Components + Radix/Tailwind client components).
   - Serves the REST API under `app/api/v1/**` route handlers and the SSE stream.
   - **Read-mostly.** Writes are admin actions (mute list, config, alert-rule edits, acknowledgements), owned-node management, and queueing TX requests into `tx_outbox`; none touch the ingest hot path, and the web process itself never publishes to the mesh (the worker drains the outbox behind the safety rails).

2. **`ingest` - standalone Node daemon** (not part of the Next.js runtime)
   - One MQTT client per configured broker, each with its own credentials, TLS, topic list.
   - Decodes `ServiceEnvelope` protobuf and JSON-topic traffic.
   - Tolerates malformed messages, counts them per topic.
   - Writes `packets` + one `receptions` row per gateway observation, plus decoded side rows (positions, telemetry, nodeinfo → identity events, traceroutes → link events).
   - Appends to `live_events` for the SSE layer.
   - Maintains an in-process dedup LRU keyed by `(from_node, mesh_packet_id)` with TTL = `idempotency_window_seconds`, backed by a DB unique index as a hard backstop.
   - **Throughput (regional/2000-node target):** inserts are batched (multi-row `INSERT`, flushed on count or a short timer) so a single process sustains the 2-5M receptions/day rate. **Scale-out path:** run N ingest workers partitioned by broker (or by `from_node` hash); the DB unique index on `packets.uq_dedup` becomes the authoritative dedup and the per-worker LRU is just an optimization. No model change required.

3. **`worker` - standalone Node scheduler**
   - Continuous rollups (hourly/daily) via incremental upserts.
   - Retention: drops expired partitions; trims `live_events`.
   - Direct-heard / link aggregate maintenance.
   - Alert evaluation and delivery (webhook, ntfy, SMTP).
   - Phase 4+ jobs: RF baselines + tropo detection, weather ingest, terrain/link-budget, battery forecasts, health-score, records.
   - Daily digest + `.ics` generation.

4. **`db` - MySQL 8**
   - Primary store. The **only** channel between processes (per the "communicate only through the database" constraint).

```
                 ┌─────────────┐        ┌─────────────┐
 MQTT broker(s)──►│   ingest    │        │   worker    │
                 │  daemon     │        │  scheduler  │
                 └──────┬──────┘        └──────┬──────┘
                        │  writes packets/     │ rollups, alerts,
                        │  receptions/events,  │ retention, digests
                        │  live_events         │
                        ▼                      ▼
                    ┌───────────────────────────────┐
                    │            MySQL 8             │
                    └───────────────┬───────────────┘
                                    │ reads (rollups, curated tables)
                                    │ tails live_events for SSE
                                    ▼
                            ┌───────────────┐
                            │  Next.js web  │──► UI + REST API + SSE
                            └───────────────┘
```

### Data flow (ingest path)

1. MQTT message arrives on a subscribed topic.
2. Connector records the raw topic + payload and classifies protobuf vs JSON.
3. Decoder parses `ServiceEnvelope`; on failure the raw bytes are stored and the topic's malformed counter increments.
4. On success: upsert the logical `packet` (dedup key), insert one `reception` for this gateway observation.
5. Decode the inner `Data` by portnum; write typed side rows (position, telemetry, nodeinfo/identity events, traceroute/link events). Undecryptable payloads are stored in `packet_payloads` for later re-decode.
6. Classify the reception's directness (Section 4) and update `gateway_node_link` / `gateway_heard_direct` aggregates.
7. Append a compact `live_events` row.
8. `worker` folds new rows into rollups on its schedule.

### Live updates without `LISTEN/NOTIFY` (MySQL accommodation)

MySQL has no `LISTEN/NOTIFY`. The SSE endpoint tails an append-only `live_events` table:

- `ingest` appends `(id AUTO_INCREMENT, created_at, event_type, payload JSON)`.
- The SSE route handler holds the client's last-seen `id` cursor and runs `SELECT ... WHERE id > :cursor ORDER BY id LIMIT :n` on a ~1 s tick. This is an indexed PK range scan proportional to *new* rows only - it is **not** a heavy query and satisfies "no polling loops that re-run heavy queries."
- `worker` trims `live_events` to a short window (minutes).
- Optional scale upgrade: Redis pub/sub can replace the tail table without changing the client contract. Documented, not required.

### Failure modes and resilience

| Failure | Behavior |
|---|---|
| Broker disconnect | Mark broker degraded; auto-reconnect with backoff; surface connection state + last-message age in `/api/v1/health` and `/metrics`. Buffered messages are re-processed idempotently. |
| Malformed protobuf/JSON | Store raw topic + payload, increment per-topic malformed counter, continue. Malformed rate is a broker-health signal. |
| Undecryptable payload (no key) | Store encrypted payload in `packet_payloads`; packet row marked `decode_status = 'encrypted'`; re-decode job runs when a key is added. |
| DB outage | Ingest applies bounded in-memory + disk spool buffering, stops cleanly if buffer fills, resumes without dup writes (dedup key + unique index). |
| Duplicate delivery / restart | Idempotent upserts keyed by packet dedup key; receptions keyed by `(packet dedup key, gateway_id, rx_time)`. |
| Worker crash mid-rollup | Rollups are recomputable and idempotent (upsert by bucket key); a watermark table records the last fully-folded bucket so work resumes. |
| Clock skew on gateways | Store both gateway-reported `rx_time` and server `received_at`; ingest lag = `received_at − rx_time`; analytics prefer `received_at` for ordering. |

---

## 3. Database schema and partitioning strategy

### MySQL conventions

- Engine InnoDB, charset `utf8mb4`.
- **Datetimes:** `DATETIME(3)` storing **UTC** (millisecond precision). `TIMESTAMP` is avoided (2038 range + implicit session-tz conversion). The application layer is timezone-aware and renders the config local tz.
- **Node/gateway ids:** Meshtastic node numbers are uint32 → `INT UNSIGNED`. Mesh packet id → `INT UNSIGNED`.
- **Surrogate keys:** `BIGINT UNSIGNED AUTO_INCREMENT` (never random UUIDs - they fragment the InnoDB clustered index).
- **Payloads/keys:** `VARBINARY`/`BLOB`. Public keys `VARBINARY(32)`.
- **Flexible fields:** `JSON`.

### Partitioning rules (MySQL-specific, important)

MySQL imposes two rules that shape the schema:

1. **Every unique key (including the PK) must contain all partitioning columns.** So partitioned tables use a composite PK that includes the partition datetime.
2. **Partitioned InnoDB tables cannot have foreign keys.** Cross-table references (`reception → packet`) are therefore *logical*, enforced by the application, not by DB FKs. Non-partitioned tables (nodes, gateways, config) may keep FKs.

`packets` and `receptions` use `RANGE COLUMNS(<datetime>)` with **daily** partitions plus a `pMAX` catch-all. The `worker` pre-creates future partitions and drops expired ones (fast `ALTER TABLE ... DROP PARTITION` - the mechanism that fixes Malla #22 retention).

### Core tables

#### `packets` (partitioned by `first_seen_at`, daily)

```sql
CREATE TABLE packets (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  first_seen_at   DATETIME(3)     NOT NULL,           -- partition key (UTC)
  mesh_packet_id  INT UNSIGNED    NOT NULL,           -- MeshPacket.id
  from_node_id    INT UNSIGNED    NOT NULL,           -- MeshPacket.from
  to_node_id      INT UNSIGNED    NULL,               -- MeshPacket.to (broadcast = 0xFFFFFFFF)
  dedup_bucket    INT UNSIGNED    NOT NULL,           -- floor(epoch_s / idempotency_window)
  channel_index   TINYINT UNSIGNED NULL,
  channel_id      VARCHAR(64)     NULL,               -- ServiceEnvelope.channel_id
  port_num        SMALLINT UNSIGNED NULL,             -- decoded Data.portnum
  decode_status   ENUM('decoded','encrypted','malformed','partial') NOT NULL,
  decode_error    VARCHAR(255)    NULL,
  want_ack        TINYINT(1)      NOT NULL DEFAULT 0,
  via_mqtt        TINYINT(1)      NOT NULL DEFAULT 0,
  payload_format  ENUM('protobuf','json') NOT NULL,
  raw_json        JSON            NULL,               -- when source was a JSON topic
  reception_count INT UNSIGNED    NOT NULL DEFAULT 0, -- denormalized count of gateway copies
  source_broker_id VARCHAR(64)    NULL,
  PRIMARY KEY (id, first_seen_at),
  UNIQUE KEY uq_dedup (from_node_id, mesh_packet_id, dedup_bucket, first_seen_at),
  KEY ix_from_time (from_node_id, first_seen_at),
  KEY ix_port_time (port_num, first_seen_at)
) ENGINE=InnoDB
PARTITION BY RANGE COLUMNS (first_seen_at) ( /* daily pYYYYMMDD ... , pMAX */ );
```

Notes:
- `dedup_bucket` gives a coarse time window so re-uplinks of the same mesh packet collapse to one logical packet. The unique key includes `first_seen_at` (partition rule); a packet re-uplinked across a midnight boundary is the one known edge case (two logical rows) - accepted and documented; the ingest LRU catches the common case.
- Decoded plaintext is **not** stored in `packets`; typed decoded values live in side tables (positions/telemetry/etc.). Encrypted bytes go to `packet_payloads`.

#### `receptions` (partitioned by `rx_time`, daily) - the heart of the model

```sql
CREATE TABLE receptions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rx_time         DATETIME(3)     NOT NULL,           -- partition key; gateway-reported (UTC), fallback received_at
  received_at     DATETIME(3)     NOT NULL,           -- server ingest time (UTC)
  packet_id       BIGINT UNSIGNED NOT NULL,           -- logical FK to packets.id (not DB-enforced)
  packet_first_seen_at DATETIME(3) NOT NULL,          -- carried so joins stay partition-aligned
  gateway_id      INT UNSIGNED    NOT NULL,
  from_node_id    INT UNSIGNED    NOT NULL,           -- denormalized for gateway×node queries
  rx_rssi         SMALLINT        NULL,               -- dBm; NULL = not present
  rx_snr          FLOAT           NULL,               -- dB;  NULL = not present
  hop_start       TINYINT UNSIGNED NULL,              -- absent on old firmware
  hop_limit       TINYINT UNSIGNED NULL,
  relay_node      TINYINT UNSIGNED NULL,              -- last byte of relayer node id; 0/absent = none
  reception_class ENUM('rf_direct','rf_direct_low_conf','rf_relayed',
                       'mqtt_self','mqtt_injected','unknown') NOT NULL,
  raw_topic       VARCHAR(255)    NOT NULL,
  source_broker_id VARCHAR(64)    NOT NULL,
  is_json         TINYINT(1)      NOT NULL DEFAULT 0,
  ingest_lag_ms   INT             NULL,               -- received_at - rx_time
  PRIMARY KEY (id, rx_time),
  KEY ix_gw_node_time  (gateway_id, from_node_id, rx_time),
  KEY ix_node_time     (from_node_id, rx_time),
  KEY ix_packet        (packet_id, rx_time),
  KEY ix_class_time    (reception_class, rx_time)
) ENGINE=InnoDB
PARTITION BY RANGE COLUMNS (rx_time) ( /* daily pYYYYMMDD ..., pMAX */ );
```

#### `packet_payloads` - encrypted-payload retention (fixes Malla #24)

Non-partitioned (or its own daily partitioning under `raw_payload_days` retention).

- `packet_id BIGINT UNSIGNED`, `packet_first_seen_at DATETIME(3)` (logical key), `encrypted_payload VARBINARY`(or BLOB), `channel_id VARCHAR(64)`, `tried_key_ids JSON`, `stored_at DATETIME(3)`, `redecoded_at DATETIME(3) NULL`. Re-decode job scans `redecoded_at IS NULL` when a new key is added.

#### `packet_topics` - per-topic health

`topic_path VARCHAR(255) PK`, `broker_id`, `valid_count BIGINT`, `malformed_count BIGINT`, `last_seen_at`, `last_error VARCHAR(255)`.

#### `nodes` - current identity snapshot + lifetime counters

`node_id INT UNSIGNED PK`, `long_name`, `short_name`, `hw_model`, `role`, `public_key VARBINARY(32)`, `public_key_hex CHAR(64)`, `firmware_version`, `first_seen_at`, `last_seen_at`, `last_position_at`, `is_gateway TINYINT(1)`, `is_relay TINYINT(1)`, `mute_hidden TINYINT(1)`, `spoof_flag_count INT`, `anomaly_flag_count INT`, `total_packet_count BIGINT UNSIGNED`, `total_reception_count BIGINT UNSIGNED`, `total_direct_gateways SMALLINT UNSIGNED`, `spam_score FLOAT`, `last_health_score FLOAT`.

> **Lifetime counters here are deliberate:** ghost-hunter (heard once *ever*) and records must survive raw-row purges. They are maintained incrementally by ingest/worker, not scanned from raw.

#### `node_identity_events` - identity history (fixes Malla #73/#63/#74)

`event_id BIGINT PK`, `node_id`, `event_type ENUM('long_name','short_name','hw_model','role','public_key','firmware')`, `old_value`, `new_value`, `observed_at`, `source_packet_id`, `source_packet_first_seen_at`. Spoof detection reads this: a `public_key` change for an existing node, or NodeInfo fields flapping between distinct value sets, raises a flag + alert.

#### `node_flags` - spoof/anomaly/role-violation flags

`flag_id`, `node_id`, `flag_type ENUM('spoof_pubkey','identity_flap','role_violation','anomaly')`, `severity`, `message`, `created_at`, `resolved_at`, `acknowledged_at`, `acknowledged_by`, `evidence` JSON (denormalized so evidence survives raw purge). Backs the new-node / anomaly review queue.

#### `node_positions` (current) + `node_position_events` (history)

Current: `node_id PK`, `lat`, `lon`, `alt_m`, `precision_bits`, `source`, `last_updated_at`.
Events: `event_id`, `node_id`, `lat`, `lon`, `alt_m`, `observed_at`, `source_packet_id`. Backs position track + link-budget + map replay.

#### `node_telemetry` - long, downsamplable series

`id`, `node_id`, `metric ENUM('battery_pct','voltage','chan_util','air_util_tx','temperature','humidity','pressure','current','iaq','uptime', ... )`, `value DOUBLE`, `observed_at`, `source_packet_id`. Indexed `(node_id, metric, observed_at)`. Retention `telemetry_days` (default 365) so battery forecasting has history. Partitioned daily at scale.

#### `gateways` - catalog + state

`gateway_id INT UNSIGNED PK`, `is_our_gateway TINYINT(1)`, `owner_node_id`, `first_seen_at`, `last_seen_at`, `active TINYINT(1)`, `broker_id`, `metadata JSON`.

#### `gateway_node_link` - the matrix backing table (direct **and** relayed)

Per `(gateway_id, node_id)` pair, lifetime aggregate:
`gateway_id`, `node_id`, PK `(gateway_id, node_id)`,
`direct_count BIGINT`, `relayed_count BIGINT`, `unknown_count BIGINT`,
`first_direct_at`, `last_direct_at`, `first_relayed_at`, `last_relayed_at`,
`rssi_min/max`, `rssi_sum`, `rssi_sumsq`, `snr_min/max`, `snr_sum`, `snr_sumsq` (avg + stddev derivable),
`last_rssi`, `last_snr`, `last_relay_node`, `best_path JSON`, `status ENUM('direct','relayed','never')`.
Backs the gateway×node matrix and per-pair charts without scanning receptions.

#### `gateway_heard_direct` - per-gateway direct roster (subset view)

Kept as a first-class table for fast roster rendering + CSV export: `gateway_id`, `node_id`, `first_heard_direct`, `last_heard_direct`, `reception_count`, `rssi_min/max/avg`, `snr_min/max/avg`, `last_rssi`, `last_snr`, `trend_slope`, `status`. PK `(gateway_id, node_id)`. (Derivable from `gateway_node_link`; materialized for query speed.)

#### `relay_nodes` - relay inventory + role validation

`relay_node_byte TINYINT UNSIGNED`, candidate `node_id`(s) JSON, `first_seen_at`, `last_seen_at`, `evidence_count`, `claimed_role`, `role_violation TINYINT(1)` (e.g. CLIENT_MUTE observed relaying).

#### `link_events` - traceroute + observed links

`id`, `from_node_id`, `to_node_id`, `observed_at`, `direction ENUM('forward','back')`, `hop_count`, `route JSON` (node list), `snr_towards JSON`, `snr_back JSON`, `rtt_ms`, `source_packet_id`. Backs traceroute list/graph, link asymmetry, longest links, and fastest-RTT record.

### Rollup tables (worker-maintained)

All rollups are upserted with `INSERT ... ON DUPLICATE KEY UPDATE` keyed by `(bucket_start, dims...)`. A `rollup_watermark` table stores the last fully-folded bucket per rollup so restarts resume cleanly. Rollups are the **only** source for dashboard counters.

**Retention at 2000-node scale:** all `*_day` rollups and the low-cardinality hourly rollups (`node_rollup_hour`, `gateway_rollup_hour`, `mesh_rollup_hour`) are **kept indefinitely** as the prompt requires - their yearly growth is bounded (mesh ≈ 9k rows/yr; node ≈ 17M/yr; gateway small). The one exception is **`reception_rollup_hour`** (gateway×node×hour): at ~2000 nodes × tens of gateways this is ~10-50M rows/yr, so it is partitioned daily and retained for a **configurable** window (`retention.reception_rollup_hour_days`, default 365). Its `*_day` counterpart stays indefinite, so long-range per-pair history (best-gateway advisor, seasonal tropo correlation) is preserved at daily granularity forever; hour-level detail is preserved for the configured window.

#### `reception_rollup_hour` / `reception_rollup_day`

PK `(bucket_start, gateway_id, node_id)`:
`packet_count`, `direct_count`, `relayed_count`, `unknown_count`,
`rssi_min/max`, `rssi_sum`, `rssi_sumsq`, `rssi_p50`,
`snr_min/max`, `snr_sum`, `snr_sumsq`, `snr_p50`,
`rssi_direct_sum`, `rssi_direct_count`, `rssi_direct_p50`, `snr_direct_p50` (rf_direct only).

> **`rssi_p50`/`snr_p50` (approximate median per bucket) are added in Phase 1 on purpose:** the Phase 4 tropo detector needs a rolling-median baseline. The worker computes per-bucket p50 at fold time (when raw is still present), so Phase 4 never re-ingests. Long-range baselines read rollup p50; short baselines (default 24 h) read raw within `decoded_packet_days`.
>
> **Rule 4 note (post-Phase-4):** the plain `rssi_p50`/`snr_p50` blend `rf_direct` and `rf_relayed`, so a relayed hop's RF pollutes what should describe the source node's own link. The tropo baseline and the per-node signal-quality trend now read the `*_direct_p50` (and `rssi_direct_sum/count`) columns, which fold `rf_direct` receptions only. The blended columns remain for coverage/utilization views that legitimately count all RF.

#### `node_rollup_hour` / `node_rollup_day`

PK `(bucket_start, node_id)`: `packet_count`, `reception_count`, `direct_heard_count`, `relayed_count`, `unique_gateways`, `bytes_seen`, `est_airtime_ms`, `chan_util_avg`, `air_util_tx_avg`, per-portnum counts JSON. Backs top talkers, airtime hogs, fingerprinting (hour-of-day × day-of-week), utilization.

#### `gateway_rollup_hour` / `gateway_rollup_day`

PK `(bucket_start, gateway_id)`: `packet_count`, `reception_count`, `direct_heard_nodes`, `malformed_count`, `lag_ms_avg`, `last_seen_at`.

#### `mesh_rollup_hour` / `mesh_rollup_day`

PK `(bucket_start)`: `active_nodes`, `new_nodes`, `unique_gateways`, `total_packets`, `total_receptions`, `malformed_packets`, `avg_chan_util`, `avg_air_util_tx`, `delivery_ratio`, `spoof_flags`, `health_score`. Backs the dashboard, utilization trend, health-score history, and digest deltas.

### Phase 4+ event/record tables (created in Phase 1 migrations)

- `propagation_events`: `id`, `gateway_id`, `node_id`, `detected_at`, `event_type ENUM('enhancement','dx_direct')`, `baseline_rssi`, `observed_rssi`, `delta_db`, `distance_km`, `duration_s`, `confidence`, `metadata JSON`.
- `records` + `records_history`: `record_type`, `value DOUBLE`, `unit`, `node_a`, `node_b`, `achieved_at`, `evidence JSON` (**denormalized** RSSI/distance/packet summary so records outlive raw purge), `superseded_at`. History keeps broken records.
- `alerts`: `id`, `rule_id`, `severity`, `title`, `body`, `created_at`, `fired_key` (dedup), `resolved_at`, `acknowledged_at`, `delivery JSON` (per-channel status).
- `weather_obs` (created when weather enabled; forward-fill only): `station_id`, `observed_at`, `temp_c`, `humidity`, `pressure_hpa`, `wind`, `precip`.
- `terrain_link_budget` (Phase 4): `node_a`, `node_b`, `computed_at`, `distance_km`, `expected_path_loss_db`, `fresnel_clearance`, `observed_rssi`, `deficit_db`, `profile JSON`.
- `battery_forecast` (Phase 4): `node_id`, `computed_at`, `power_profile ENUM('solar','mains','battery')`, `slope`, `projected_dead_at`, `confidence`.

### Operational / config tables

- `broker_health`: `broker_id`, `connected`, `last_message_at`, `messages`, `malformed`, `reconnects`, `updated_at`.
- `live_events`: `id BIGINT AUTO_INCREMENT PK`, `created_at`, `event_type`, `payload JSON` (trimmed to minutes).
- `mute_list`: `node_id PK`, `reason`, `added_by`, `added_at`, `source ENUM('config','admin')`. Display-only; never affects ingest or the mesh.
- `admin_users`: `id`, `username`, `password_hash`, `role`. `api_tokens`: `id`, `token_hash`, `label`, `scopes JSON`, `created_at`, `last_used_at`, `revoked_at`.
- `rollup_watermark`, `schema_migrations`.

---

## 4. Direct-heard detection logic

### Inputs (Meshtastic `ServiceEnvelope` → `MeshPacket`)

From the envelope: `gateway_id`, `channel_id`. From the packet header: `from`, `to`, `id`, `hop_limit`, `hop_start`, `want_ack`, `via_mqtt`, `rx_time`, `rx_rssi`, `rx_snr`, `relay_node`. Field availability varies by firmware - `hop_start` and `relay_node` are absent on older firmware.

### Classification (produces `receptions.reception_class`)

Let `hops_used = hop_start − hop_limit` when both are present.

```
if gateway_id == from_node_id:
    → mqtt_self               # node uplinked its OWN traffic; NOT proof anyone heard it over RF
elif rx_rssi is absent AND rx_snr is absent:
    → mqtt_injected           # no RF metadata → arrived via MQTT, not an RF reception
elif hop_start present AND hop_limit present:
    if hops_used == 0:        # zero hops used
        → rf_direct           # + requires rx_rssi or rx_snr present (guaranteed by branch above)
    else:
        → rf_relayed
else:                          # hop_start absent (old firmware) but RF metadata present
    if relay_node present AND relay_node != 0:
        → rf_relayed          # relay byte proves a relay handled it
    else:
        → rf_direct_low_conf  # RF metadata present, hop count unknowable → tentative, tracked separately
```

Rules:
- **`rf_direct` is the only class that feeds the confirmed direct-heard roster.** `rf_direct_low_conf` is stored and shown separately (never silently merged) so old-firmware nodes don't inflate direct counts.
- **`mqtt_self`** flags the node as MQTT-attached (`nodes.is_gateway = 1` when it appears as `gateway_id`), and is excluded from RF direct-heard stats.
- **`mqtt_injected`** is excluded from all RF link stats but still recorded (it's real traffic).
- **`relay_node`** is decoded and stored for every reception; non-zero values populate `relay_nodes`, `gateway_node_link.last_relay_node`, and best-path reconstruction, and validate role claims (CLIENT_MUTE seen relaying → `role_violation`).

### Edge cases (explicit)

1. **`hop_start` absent (old firmware):** never assume direct. Classify `rf_direct_low_conf` (RF present) or lean on `relay_node`. Kept out of confirmed direct counts.
2. **Self-gated (`gateway_id == from`):** `mqtt_self`; MQTT-attached, not RF-heard. Separate roster column.
3. **MQTT-injected, no RF metadata:** `mqtt_injected`; excluded from direct/relayed RF stats.
4. **Zero-hop with RF metadata:** the canonical `rf_direct`; feeds roster + `gateway_node_link` + `reception_rollup`.
5. **`rx_rssi`/`rx_snr` present but exactly 0:** treated as present-but-suspect; kept, but flagged in metadata (some gateways emit 0 for "unknown").

### Derived per-`(gateway, node)` state (maintained incrementally)

`first_heard_direct`, `last_heard_direct`, `reception_count`, RSSI min/max/avg (+stddev), SNR min/max/avg (+stddev), recent trend (rolling slope over last N hours from `reception_rollup_hour`), best-known relayed path + last relay byte, and a matrix status ∈ {direct, relayed, never} colored by last-heard age.

### Attribution model

- **Our gateways:** those with `gateways.is_our_gateway = 1` (config-scoped).
- **MQTT-connected nodes:** any node id observed as a `gateway_id`.
- **Direct-heard roster:** `rf_direct` receptions only.
- **Relayed-only nodes:** nodes with `direct_count = 0` across all our gateways but `relayed_count > 0` - shown with best path + relay byte.

---

## 5. API surface

### Auth model

- **Read-only by default.** Anonymous read-only mode is a config toggle; when off, reads require a bearer token.
- **Bearer tokens** (`Authorization: Bearer <token>`) hashed at rest in `api_tokens`, each carrying a `role_key` (RBAC) and a `can_tx` flag; the original `scopes JSON` design was replaced by RBAC roles.
- **Role-based access control (v2.0).** Access is granted per feature module by role (`src/auth/modules.ts`, `rbac` config). Anonymous requests resolve to `rbac.anonymous_role`, tokens to their role, signed-in non-admin accounts to `rbac.member_role`. A module a role lacks is hard-blocked (nav hidden, page and API return 403). Roles are edited in `/admin/roles`.
- **Admin session** (cookie) required for admin mutations: mute list, config view/validate, alert-rule edits, flag acknowledgement, role and TX management. `admin_users` also carries optional `discord_id` / `discord_username` for Discord SSO.
- **TX is the one publishing path (v2.0, opt-in).** `/api/v1/tx/*` queue rows into `tx_outbox` for callers with `can_tx`; the worker publishes behind the arm + rate + channel-util rails. When TX is disabled or disarmed (the default), nothing in the API reaches the mesh/MQTT.

### Conventions

- Everything the UI shows is reachable under `/api/v1/**` (fixes Malla #62).
- OpenAPI 3.1 document generated from the route definitions, served at `/api/v1/openapi.json`.
- List endpoints: cursor pagination, uniform `?from&to&limit&cursor` time filtering, `?format=csv` for exports.
- `/api/version` returns semver + git commit (also shown in the footer).

### Endpoints (outline)

**Packets / receptions**
`GET /packets` (filters: node, gateway, port, channel, time, `class`, malformed) · `GET /packets/{id}` (with payload preview per port) · `GET /receptions` · `GET /receptions/{id}` · `GET /packets.csv` · `GET /receptions.csv`

**Nodes**
`GET /nodes` · `GET /nodes/{id}` · `GET /nodes/{id}/biography` · `GET /nodes/{id}/telemetry?metric=&downsample=` · `GET /nodes/{id}/positions` · `GET /nodes/{id}/identity-history` · `GET /nodes/{id}/battery-forecast` · `GET /nodes/{id}/fingerprint`

**Gateways / direct-heard**
`GET /gateways` · `GET /gateways/{id}` · `GET /gateways/{id}/heard-direct` (+`.csv`) · `GET /gateways/matrix` · `GET /gateways/compare` · `GET /links/{gateway_id}/{node_id}/history` (RSSI/SNR series)

**Analytics**
`GET /analytics/coverage` · `/channel-utilization` · `/top-talkers` · `/airtime` · `/spam-score` · `/link-asymmetry` · `/longest-links` · `/hop-analysis` · `/health-score` (+breakdown) · `/records` · `/propagation-events` · `/ghost-nodes` · `/best-gateway/{node_id}` · `/link-budget/{a}/{b}`

**Live**
`GET /live/stream` (SSE, tails `live_events`) · `GET /live/dashboard` (rollup snapshot)

**Replay**
`GET /replay?from&to&speed` (rollup-backed frames: packet pulses, node appearances, link formation/decay)

**Admin (session)**
`GET/POST /admin/mute-list` · `GET /admin/config` · `POST /admin/config/validate` · `GET/POST /admin/alert-rules` · `POST /admin/flags/{id}/ack` · `POST /admin/payloads/redecode`

**Ops**
`GET /healthz` · `GET /readyz` · `GET /metrics` (Prometheus) · `GET /api/v1/health` (broker state, ingest lag) · `GET /api/version`

**Feeds / exports**
`GET /feeds/events.ics` (ical-generator: new nodes, records, propagation events, alerts) · `GET /exports/reference-sheet.pdf` (Phase 5) · `GET /exports/aprs` (Phase 5, config-gated)

### `/metrics` (Prometheus)

ingest rate, ingest lag seconds, per-broker connected/malformed counters, node counts, active nodes, per-gateway direct-heard counts, rollup watermark age, alert fire counts. Ships with an example Grafana dashboard JSON.

---

## 6. Config schema

Single YAML file, **every key overridable by an environment variable** (dotted path → `HOPWATCH_*`, e.g. `HOPWATCH_DATABASE_MYSQL_PASSWORD`). Validated at startup with actionable messages; the process refuses to start on invalid config.

```yaml
version: 1

server:
  host: 0.0.0.0
  port: 3000
  local_timezone: America/Chicago      # render tz; storage is always UTC
  auth:
    anonymous_read_only: true          # false → reads need a token
    admin_users_seed: []               # bootstrap admin(s); passwords via env
  ui:
    brand_name: HopWatch
    tile_provider:                     # fixes Malla #48 - default works with no third-party key
      name: osm
      url_template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      attribution: "© OpenStreetMap contributors"
      api_key: ""
    role_colors:                       # consistent across map, graph, tables
      CLIENT: "#3b82f6"
      CLIENT_MUTE: "#9ca3af"
      ROUTER: "#22c55e"
      ROUTER_CLIENT: "#16a34a"
      REPEATER: "#f59e0b"

database:
  mode: mysql                          # mysql | sqlite
  mysql:
    host: db
    port: 3306
    database: hopwatch
    user: hopwatch
    password: "${HOPWATCH_DB_PASSWORD}"
    tls: { enabled: false, ca_file: "", reject_unauthorized: true }
    pool: { min: 10, max: 40 }         # sized for regional write rate + web reads
  sqlite:
    path: ./data/hopwatch.sqlite
    journal_mode: WAL
  partitioning:
    granularity: day                   # day | week
    precreate_ahead_days: 7

retention:                             # fixes Malla #22 (partition drops)
  raw_payload_days: 14                 # packet_payloads (encrypted bytes)
  decoded_packet_days: 90              # packets + receptions partitions (~200-450M rows at 2000 nodes)
  telemetry_days: 365
  live_events_minutes: 10
  reception_rollup_hour_days: 365      # high-cardinality gateway×node×hour; daily counterpart kept forever
  rollups_indefinite: true             # applies to all *_day rollups + low-cardinality *_hour rollups

ingest:
  single_process_dedup: true
  idempotency_window_seconds: 300      # dedup_bucket size
  disk_spool_path: ./data/spool
  brokers:
    - id: primary
      host: mqtt.example.org
      port: 8883
      username: ""
      password: "${HOPWATCH_BROKER_PRIMARY_PASSWORD}"
      client_id: hopwatch-primary
      tls: { enabled: true, insecure_skip_verify: false, ca_file: "", cert_file: "", key_file: "" }
      qos: 0
      topics:                          # multi-root
        - "msh/+/2/e/#"                # protobuf
        - "msh/+/2/json/#"             # JSON (captured, keyed to same model)
  decode:
    tolerate_malformed: true
    channel_keys:                      # multiple keys incl. default; enables re-decode
      - { name: default, key: "AQ==" }
      - { name: private_a, key: "" }

analytics:
  direct_heard:
    low_conf_when_hop_start_absent: true
    self_gated_separate: true
  mute:
    seed: []                           # display-only; merged with admin-managed mute_list
  spam_score:
    window_hours: 24
    weights: { rate: 0.6, duplicate_ratio: 0.3, low_value_ports: 0.1 }
  health_score:                        # formula + weights in config; UI shows breakdown
    weights: { utilization: 0.25, delivery_ratio: 0.25, gateway_coverage: 0.20, active_node_trend: 0.15, anomalies: 0.15 }
  records:
    enabled: true

rf:
  propagation:                         # Phase 4
    enabled: false
    baseline_window_hours: 24
    improvement_threshold_db: 10
    dx_distance_threshold_km: 25
  link_budget:                         # Phase 4
    enabled: false
    terrain_source: srtm
    cache_dir: ./data/terrain
    max_distance_km: 60
    underperform_margin_db: 8
  weather:                             # Phase 4, off by default
    enabled: false
    provider: nws                      # nws | metar
    stations: []
    refresh_interval_minutes: 60

alerts:
  enabled: true
  delivery:
    webhook: []                        # list of URLs
    ntfy: []                           # list of topics/servers
    smtp: { host: "", port: 587, user: "", password: "${HOPWATCH_SMTP_PASSWORD}", from: "", starttls: true }
  rules:                               # NO hardcoded rule types; all config
    - { id: node-offline,   type: node_offline,      enabled: true, threshold_minutes: 60, channels: [smtp] }
    - { id: battery-low,    type: battery_threshold, enabled: true, threshold_volts: 3.3, channels: [ntfy] }
    - { id: spoof,          type: spoof_flag,        enabled: true, channels: [webhook, smtp] }
    - { id: new-node,       type: new_node,          enabled: true, channels: [ntfy] }
    - { id: gateway-silent, type: gateway_silent,    enabled: true, threshold_minutes: 30, channels: [smtp] }
    - { id: chan-util-high, type: channel_util,      enabled: true, threshold_pct: 40, channels: [webhook] }
    - { id: node-dark-soon, type: battery_forecast,  enabled: false, days_ahead: 5, channels: [smtp] }  # Phase 4

digest:                                # Phase 3
  enabled: false
  time: "08:00"                        # local_timezone
  channels: [smtp]
  include: [new_nodes, silent_nodes, records, spoof_flags, propagation_events, utilization_trend, health_score_delta]
  attach_ics: true                     # ical-generator

features:
  live_views: true
  aprs_is_export: false                # Phase 5, off by default, outbound-only
  reference_sheet_pdf: false           # Phase 5
  ambience_mode: false                 # Phase 5, client-side only

aprs_is:                               # Phase 5 (only if features.aprs_is_export)
  mode: file                           # file | is
  opted_in_nodes: []
  is: { server: "", port: 14580, callsign: "", passcode: "" }
```

### Validation at startup

At least one broker with host/port/topics; retention values ≥ 0 and coherent (`raw_payload_days ≤ decoded_packet_days`); channel keys valid base64 or empty; tile `url_template` contains `{z}/{x}/{y}`; alert rules reference known `type`s and supply their required fields; SMTP present iff any channel uses it; `local_timezone` is a valid IANA zone. Each key is documented in `docs/config.md` with default, description, env-var name, and validation rule.

---

## 7. Phased build plan

**Phase 1 - ingest + storage + direct-heard + packet browser**
MQTT connectors (multi-broker/TLS); protobuf + JSON decode with malformed tolerance/counting; MySQL repository layer + partitioned `packets`/`receptions` + full Phase-1 schema (incl. all event/rollup/record tables below); dedup + idempotency; reception classification + `gateway_node_link`/`gateway_heard_direct`; encrypted-payload retention + re-decode job; packet browser UI (Radix/Tailwind) with filters + CSV; `/healthz`, `/metrics`, broker health page; docker-compose (mysql + ingest + worker + web) with migrate-on-startup; version/commit footer.

**Phase 2 - map, graph, core analytics, node biography**
Node explorer; MapLibre map with positions + RF links (role colors); traceroute list + graph; gateway compare + longest links + hop analysis; coverage heatmap; matrix view; per-pair RSSI/SNR charts (uPlot); telemetry time-series with downsampling; node biography page (event-assembled, printable).

**Phase 3 - API, live views, alerting, daily digest**
Versioned REST API + OpenAPI + token auth + admin session + anonymous-read toggle; SSE live feed + live dashboard + per-table auto-refresh with visible pause; config-driven alert engine + webhook/ntfy/SMTP delivery; daily digest (text + HTML) with `.ics` attachment + `/feeds/events.ics`; mute list + wall of spammers.

**Phase 4 - RF/propagation, replay, health, records**
Tropo/ducting detector (rolling-median baselines from rollup p50 + raw); weather ingest + correlation report; terrain link-budget validator (SRTM cache, Fresnel, cross-section UI); best-gateway advisor; mesh replay (rollup-backed timeline); mesh health score (config weights + breakdown); records board + history; battery death predictor → alert feed.

**Phase 5 - outputs + engagement**
APRS-IS export (file/IS, opted-in, outbound-only); reference-sheet PDF (ICS-217 layout, config-mapped); traffic fingerprinting; ghost node hunter; audio ambience mode (client-side, same SSE stream).

---

## 8. Phase 4+ prerequisites that must exist in Phase 1 (deliverable #7)

Nothing in Phase 1 storage may preclude a later phase. The following are created by Phase 1 migrations (empty tables + forward-filled columns are cheap; re-ingesting history later is not possible):

| Later feature | Phase-1 dependency | Why it must exist up front |
|---|---|---|
| Tropo/ducting detector | `reception_rollup_hour/day` **with `rssi_p50`/`snr_p50`, sum, sumsq**; `propagation_events` | Rolling-median baselines can't be reconstructed from avg-only rollups; p50 must be computed while raw is present. |
| Weather correlation | `reception_rollup_*`; `weather_obs` (created when enabled) | RSSI history comes from rollups; weather is forward-fill from enable time (documented gap for pre-enable history). |
| Link budget validator | `node_position_events`; `reception_rollup_*` | Needs full position history + observed RSSI over time. |
| Best-gateway advisor | `reception_rollup_*` per `(gateway,node)` | Quality/consistency ranking over time. |
| Mesh replay | `reception_rollup_*`, `node_position_events`, `link_events` | Week-long replay must read rollups, never raw. |
| Node biography | `node_identity_events`, `node_position_events`, `node_telemetry`, `node_flags`, `records` | Assembled entirely from event rows. |
| Battery predictor | `node_telemetry` (voltage/battery) + `telemetry_days` retention | Needs long discharge history. |
| Health score / trend | `mesh_rollup_*`, `node_rollup_*`, `node_flags` | Continuous inputs + history for deltas. |
| Records board | `records`/`records_history` with **denormalized evidence** | Evidence must survive `decoded_packet_days` purge. |
| Ghost hunter | `nodes.total_reception_count` (+ gateway pair rows) | "Heard once *ever*" survives raw purge only via lifetime counters. |
| Fingerprinting | `node_rollup_hour` (hour-of-day × day-of-week) | Duty-cycle heatmap from rollups. |

---

## 9. UI/UX expectations

- **Dashboard:** counters from rollups only; live-stream toggle with visible pause; gateway coverage + direct-heard summary; newest nodes + anomaly queue; mesh health score with breakdown.
- **Every table view:** auto-refresh toggle with a visible pause state; SSE-driven, no heavy re-query loops; CSV export.
- **Nodes:** biography, telemetry charts (downsampled), position track, spoof/alert state, fingerprint heatmap, battery curve.
- **Gateways:** heard-direct roster with online/offline aging; gateway×node matrix (cell = direct/relayed/never, colored by last-heard age); per-pair RSSI/SNR history.
- **Map/graph:** positions + RF links colored by quality/recency; **role colors consistent everywhere** (from `ui.role_colors`); replay controls.
- **Payload previews:** every known port rendered (position, telemetry incl. host metrics - fixes Malla #56, nodeinfo, text, traceroute); unknown ports show hex + best-effort decode.
- **Admin:** mute list, config view + validate, alert-rule editor, broker health + ingest lag.

---

## 10. Testing (ingest decode path)

Captured real `ServiceEnvelope` fixtures covering: successful decode, **encrypted/undecryptable** (asserts payload retained + later re-decode succeeds when key added), **malformed** (asserts counted per topic, pipeline continues), **multi-gateway duplicate** (asserts one `packet` + N `receptions`), old-firmware **no `hop_start`** (asserts `rf_direct_low_conf`, not `rf_direct`), **self-gated** (`mqtt_self`), and **MQTT-injected no-RF-metadata** (`mqtt_injected`). Classification is a pure function over decoded header fields, unit-tested in isolation from the DB.

---

## 11. Open items for confirmation

1. ~~Scale~~ - **resolved: regional, ~2000 nodes.** Daily partitions, batched ingest, configurable `reception_rollup_hour` retention (§1, §3). No further input needed unless the number grows past ~5000 nodes, at which point the ingest scale-out path (§2) becomes the default rather than an option.
2. Confirm **broker count + topic roots** (defaults assume `msh/+/2/e/#` and `.../json/#`). Not blocking - the config already supports many.
3. Confirm whether **SQLite small-mode** must ship in Phase 1 or can trail MySQL (recommend: trail - it is not a supported target at 2000-node scale).
