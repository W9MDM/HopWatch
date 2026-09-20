# HopWatch Architecture and Code Audit

Read-only audit. No code was changed. Every finding cites the file and function/line where it was
observed. Conducted by reading each subsystem in full: MQTT ingest and batch writer, packet
decode/decrypt, all 40 SQL migrations, the read-query layer, the SSE/live layer, position
estimation, leaderboards/records, and the TX outbox + settings/config layer.

Severity legend: **Critical** (data loss, transmission bugs, races, scaling blockers),
**High**, **Medium**, **Low**.

## What is solid (so the criticism has context)

- Reception-vs-packet split with logical dedup (`uq_dedup`, `uq_rx`) and idempotent `INSERT IGNORE`
  restart safety; daily range-partitioning + `pmax` catch-all on the four receptions-scale tables
  with metadata-only `DROP PARTITION` retention (`db/migrations/0001_init.sql`, `src/db/partitions.ts`).
- Strict, correct UTC discipline end to end (`src/lib/time.ts`, `src/db/client.ts:26-28`
  `timezone:"Z"`, `dateStrings:true`); no local-time storage or comparison found.
- Rule 4 respected in analytics: distance/RF math excludes relayed hops
  (`rssiVsDistance` `src/db/queries.ts:1210`; `position.ts:74-79`; `getMapAt` `queries.ts:738-742`).
- Estimation is written to its own `position_estimate` table, never merged into `node_positions`,
  and labeled `position_source:'estimated'` (`src/worker/position.ts:37`, `queries.ts:783`).
- TX safety rails all live in the worker, never the UI; `process.env` usage is clean (bootstrap
  only); hot-reload via `effectiveConfig()` is genuine and disarm is a true kill switch
  (`src/worker/tx.ts:121-218`, `src/db/appsettings.ts`).
- Per-message decode errors are isolated and cannot crash the handler (`src/ingest/index.ts:104-108`).

---

## 1. Critical Architecture and Logic Issues

### C1. TX worker loop has no re-entrancy guard: duplicate RF transmission + rate-limit bypass
**Critical.** `src/worker/index.ts:109-131` (`txLoop = setInterval(() => { void safe(...) }, 10_000)`),
`src/worker/tx.ts:205-207` (state written only after `publish()` resolves),
`src/db/tx.ts:82` (`listPendingTx` selects `state IN ('queued','held')`, no in-progress state, no lock).

`setInterval` fires every 10s and does not await its async callback. The node transport takes up to
~20s per attempt and up to ~60s across its 3 retries (`src/node/transport.ts:31,54`), far exceeding
the interval. Because an outbox row stays `queued` until `publish()` resolves, an overlapping tick
re-selects the same row and transmits it again with a fresh random packet id (`src/meshtastic/encode.ts:95`).
Two consequences: (a) the same logical message is put on the air twice or more (doubles airtime,
violates good-citizen behavior); (b) the rate limiter reads only committed `sent` rows
(`src/worker/tx.ts:143,150`), so two overlapping ticks each see the same low count and each send up
to the cap, silently exceeding `tx.rate_limit` (a stated safety rail). The check-then-insert dedup in
every proactive enqueuer (`src/worker/autoresponder.ts:68-73,129`, `automations.ts:52-66`,
`weatheralerts.ts:44-45`) is likewise racy under overlap.

Fix: add a per-loop in-flight guard (or replace `setInterval` with a self-scheduling `setTimeout`
that re-arms in a `finally`), and make row selection an atomic claim
(`UPDATE tx_outbox SET state='sending' WHERE id=? AND state IN ('queued','held')`, proceed only if
one row was affected). The claim fixes the rate bypass by making in-flight rows visible.

### C2. Outbox state writes are blind (no compare-and-swap): cancel resurrection + crash re-send
**Critical.** `src/db/tx.ts:99-109` (`updateOutbox`/`setState` are `WHERE id=?` only),
`src/worker/tx.ts:205-207` (completion write), `src/db/tx.ts:165-173` (`cancelOutbox`).

An admin cancel (`.../tx/outbox/{id}/cancel`) sets `state='cancelled'` while a publish is in flight;
when the publish resolves, `updateOutbox(id,{state:'sent'})` overwrites it back to `sent`. The packet
was still transmitted and the cancel is silently undone. Separately, if the worker crashes (or the
DB write fails) after `publish()` succeeds but before the state write, the row stays `queued` and is
re-encoded with a new packet id and re-sent on restart (idempotency gap). There is no token tying an
outbox row to "already on the wire."

Fix: guard the completion write (`... WHERE id=? AND state='sending'`, treat 0 rows as
cancelled/superseded); write-ahead to `sending` and persist the intended `packet_id` before
`publish()` so a recovered `sending` row can be reconciled against `heardBy`/`tx_confirmations`
instead of blindly re-sent.

### C3. Decrypt validity heuristic accepts wrong-key garbage as a decoded packet
**Critical (silent data corruption).** `src/meshtastic/decode.ts:160-165` (`tryDecrypt`).

```ts
const data = decodeBin(m.Mesh.DataSchema, plain);
if (data && typeof data.portnum === "number" && data.portnum >= 0) {
  return { data: normalizeDataSync(data, m), keyName: k.name };
}
```

`decryptPayload` is AES-CTR and never fails cryptographically (`src/meshtastic/crypto.ts:44-46`), and
protobuf-es decode of random bytes frequently does not throw. `portnum` is a uint32 enum that is
always `>= 0` (default 0), so the gate is effectively always true. Wrong-key garbage is therefore
accepted as a valid `Data` with `portnum:0`: `tryDecrypt` returns on the first key that does not
throw and never tries the correct key (`decode.ts:155` iterates in list order); genuinely
undecryptable packets are misclassified `decoded` instead of retained as `encrypted`
(`src/ingest/pipeline.ts:162` never fires); and the RF-path channelId is derived from the wrong key
name (`decode.ts:145`).

Fix: require `portName(portnum)` to be a known port and/or a non-empty payload that re-serializes to
the same length; do not accept `portnum===0` with empty payload; prefer the key that yields a
recognized portnum over first-non-throw.

### C4. Ingest has no backpressure: unbounded in-memory queue OOMs under burst
**Critical (crash / data loss).** `src/ingest/broker.ts:64-70` (fire-and-forget
`Promise.resolve(this.onMessage(...)).catch(...)`, no `await`, no `client.pause()`),
`src/ingest/batch.ts:25-32` (`enqueue` unconditionally `this.queue.push`), `batch.ts:41`
(`flushing` single-flight guard).

If DB write rate falls below MQTT arrival rate (channel storm, telemetry flood, lock contention from
C7), `this.queue` grows without bound and the process OOMs. There is no high-water mark, no drop
policy, no stream pause. The `DedupCache` is bounded (200k) but the ingest queue is not.

Fix: cap the queue; over the cap either apply backpressure (stop reading) or drop with a counted
metric so loss is visible instead of an OOM.

### C5. Failed MQTT TX connect leaks an auto-reconnecting client, compounding during outages
**Critical (resource leak that worsens outages).** `src/tx/transport.ts:19-46` (`ensure`).

On connect error/timeout the promise rejects before `this.client = client`, so the created client is
never `end()`-ed; with `reconnectPeriod: 5000` it keeps a background reconnect loop alive forever.
During a broker outage every publish attempt (each ~10s tick, multiplied by C1 overlap) calls
`ensure()`, sees `this.client` still null, and spawns another orphaned reconnecting client:
unbounded socket/timer/memory growth for the duration of the outage. `connectedBrokerId` is also set
before the await (`transport.ts:31`), leaving the object believing it is connected to a broker it
never reached.

Fix: `client.end(true)` in the reject paths before rejecting; set `connectedBrokerId` only after a
successful connect; consider `reconnectPeriod: 0` for an on-demand transport.

### C6. Dashboard/map read queries do unindexed full-partition scans (primary scaling blocker)
**Critical at scale.** All in `src/db/queries.ts`, traced against the actual indexes in
`db/migrations/*.sql`.

- `getPacketDetail` side-lookups (`queries.ts:191-210`): `node_telemetry`, `node_position_events`,
  `node_identity_events`, `link_events` are queried `WHERE source_packet_id=?` but none index
  `source_packet_id`; `node_telemetry` is partitioned by `observed_at` with no time predicate here,
  so this is a full scan across all ~365 partitions on every packet-detail click.
- `routerBatteryFleet` (`queries.ts:1290-1294`) and `lowBatteryNodes` (`queries.ts:1888-1891`):
  `SELECT node_id, MAX(observed_at) FROM node_telemetry WHERE metric='battery_pct' GROUP BY node_id`
  with no time bound; `ix_node_metric_time` leads with `node_id`, so a `metric`-only filter cannot
  seek. Full scan of every partition of the second-largest table on each dashboard load.
- `heardByMap` (`queries.ts:613-621`) and `getMapData.allLinks` (`queries.ts:697-700`): select every
  `gateway_node_link` row with `status IN ('direct','relayed')`, no time filter, no LIMIT, then trim
  in JS. `gateway_node_link` is `G x N` and never pruned; at 30 x 5000 that is 150k rows shipped and
  sorted per render on `/map`, `/livemap`, and `/coverage`.

Fix: add `KEY (source_packet_id)` to `node_telemetry`, `node_position_events`,
`node_identity_events`, `link_events`; add a `metric`-leading index and time bounds to the battery
queries (or a worker-maintained `latest_telemetry_per_node` table); aggregate/limit `heardByMap` and
`allLinks` server-side with a recency bound.

### C7. `bumpTopic` does one un-batched upsert per message, bypassing the batch writer
**Critical under burst.** `src/ingest/index.ts:103,106` (call), contrast `src/ingest/batch.ts`.

Every message (valid or malformed) does `await bumpTopic(...)` = one
`INSERT ... ON DUPLICATE KEY UPDATE` into `packet_topics`, outside the 200-msg batch transaction.
Because the MQTT handler is fire-and-forget concurrent (C4), a flood produces hundreds of concurrent
upserts, each grabbing a pool connection (`src/db/client.ts:18`, default limit 40) and all contending
on the same few `(broker_id, topic_path)` rows, saturating the pool the batch flush also needs. This
is the single biggest per-message DB cost.

Fix: accumulate topic counts in memory and flush on a timer (or fold into the batch transaction).

### C8. Cross-gateway bucket-boundary split creates duplicate logical packets
**Critical (analytics correctness).** `src/ingest/pipeline.ts:44-49`, `src/lib/time.ts:30-32`,
`db/migrations/0001_init.sql:36` (`uq_dedup(from_node_id, mesh_packet_id, dedup_bucket, first_seen_at)`).

`dedup_bucket = floor(rxTime/1000/windowSeconds)` uses the per-gateway node-reported `rxTime`
(`decode.ts:79`). Two gateways that heard the same mesh packet but stamped `rxTime` on opposite sides
of a fixed 300s boundary get different buckets, hence two `packets` rows for one mesh packet, each
with one reception. Every reception-based analytic (coverage, gateway compare, reception_count)
double-counts that packet. Rare at 300s but guaranteed at boundaries and worse if the window is
shortened in admin.

Fix: dedup on a value identical across gateway copies (e.g. rolling first-seen lookup on
`(from, mesh_packet_id)`) rather than a floored wall-clock bucket.

### C9. SSE tailer has no re-entrancy guard and no backpressure
**Critical (stability + duplicate events).** `src/app/api/v1/live/stream/route.ts:26-46`.

`setInterval(tick, 1000)` runs an async `tick` with no running-flag; under DB latency > 1s, tick N+1
reads the same `cursor` as tick N before it advances and re-sends the same rows, double-animating the
map (client `coalesceByPacket` only dedups within one 100ms flush, `src/components/LiveMap.tsx:374`).
Separately, `controller.enqueue` never checks `controller.desiredSize`; a slow client causes
unbounded `ReadableStream` buffering (per-connection memory growth, no cap on concurrent
connections).

Fix: guard `tick` with a running flag (or self-scheduling `setTimeout`); check `desiredSize` and
drop/coalesce or close a saturated client.

### C10. Records are permanently poisoned by attacker-controlled header/GPS fields
**Critical (integrity).** `src/worker/records.ts`.

- `most_hops` (`records.ts:65-76`) uses raw `hop_start-hop_limit` with no cap; a crafted packet with
  `hop_start=255` yields hops=255 and tops the record forever (real Meshtastic hop_start is <= 7).
- `longest_direct_link_km` (`records.ts:48-62`) and `best_rssi_per_km` (`records.ts:103-119`) haversine
  against self-reported `node_positions` with no distance cap; a bogus coordinate produces a
  ~15,000 km "longest link" that tops the board permanently.
- Records are single-holder and monotonic (`records.ts:16-41`), so one bad packet poisons a board
  until manually reset; flagged/muted/`position_ignored` nodes are not excluded
  (`records.ts:48-119`, unlike `getMapData` `queries.ts:691,789`).

Fix: clamp `hop_start <= 7` and `hops BETWEEN 0 AND 7`; cap link distance to a plausible LoRa max
(~300 km); exclude `mute_hidden`/`position_ignored` before `upsertRecord`.

---

## 2. Performance and Efficiency Quick-Wins

### P1. Batch `flush()` commits the entire backlog in one transaction
`src/ingest/batch.ts:34-47`: `maxBatch` (200) is only the trigger threshold; `flush` takes the whole
queue and applies it in a single transaction. During any backlog that is thousands of rows, tens of
thousands of row locks in one commit, a giant rollback on the last-item failure, and a big all-or-
nothing retry (`batch.ts:52-58`). Fix: slice the queue into fixed `maxBatch` chunks per transaction.

### P2. Add the missing indexes from C6 (immediate, large win)
`KEY (source_packet_id)` on `node_telemetry`, `node_position_events`, `node_identity_events`,
`link_events` turns `getPacketDetail` (`queries.ts:191-210`) from 4 full scans into seeks. A
`metric`-leading index on `node_telemetry` plus time bounds fixes the battery pages
(`queries.ts:1290-1294,1888-1891`). Index `gateway_node_link.last_direct_at/last_relayed_at`
for `getGraphData` (`queries.ts:1659-1682`, currently full-scans before `LIMIT 6000`).

### P3. Serve map `hops` from rollups instead of raw receptions
`getMapData` (`queries.ts:674-681`) recomputes a full 24h receptions aggregation (millions of rows +
temp aggregation) on every `/map` render, alongside two correlated subqueries per node
(`queries.ts:666-667`) and the unbounded `heardByMap`/`allLinks`. `reception_rollup_hour` already
carries direct/relayed columns. Fix: source `hops` and `direct_gateways` from the hourly rollup;
this is the heaviest endpoint in the file.

### P4. Batch the append-only `live_events` inserts
`src/ingest/pipeline.ts:170-181` inserts 1-2 `live_events` rows per message inside the shared batch
transaction. These are append-only (no upsert), so they can be collected and written as one multi-row
insert per flush instead of per message.

### P5. One shared SSE tailer instead of per-connection polling
`src/app/api/v1/live/stream/route.ts:46`: each EventSource connection runs its own 1s DB poll, so M
viewers = M queries/sec on `live_events`. A single process-level tailer that fans out to all
connected controllers removes that multiplier. Gateway rings, per-hop SNR coloring, and animation
are already correctly client-side (`LiveMap.tsx:386-421`); only the tail sourcing is duplicated.

### P6. `recentChannelUtil()` runs once per pending row instead of once per tick
`src/worker/tx.ts:159`: the channel-util query executes inside the drain loop for every pending row,
though the value cannot change within a tick. Hoist it out of the loop.

### P7. Short-circuit the decrypt key loop for un-keyed channels
`src/meshtastic/decode.ts:155-171` runs AES + protobuf decode for every channel key on every
encrypted packet; on public MQTT (many channels HopWatch has no key for) this is O(keys) CPU per
packet and grows `packet_payloads` (`pipeline.ts:162-168`) unbounded. Skip channels/indexes already
known to be un-keyed and bound the retained-payload store.

---

## 3. Edge Cases and Robustness Gaps

### E1. Admin settings change tears down every broker connection (message loss window)
`src/ingest/index.ts:170-183` polls `configFingerprint` (`src/db/settings.ts:92-95`), which returns
the single global `settings_meta.rev` bumped by any `saveOverrides`. Editing an unrelated setting
(notifications, TX arm, etc.) triggers `reload()` (`index.ts:127-159`) which stops and reconnects
every broker. Combined with QoS 0 (E2), every message in the reconnect gap is lost. Fix: diff only
the broker/key/node subset and restart only affected connectors.

### E2. QoS 0 + clean session: silent loss across any disconnect/reconnect
`src/config/schema.ts:179` (`qos` default 0), `src/ingest/broker.ts:43-52` (no `clean:false`).
Messages published during a disconnect/reconnect window are dropped with no record. Acceptable for a
passive observatory but undocumented and invisible; at minimum surface reconnect gaps in health
metrics, optionally support QoS 1 + persistent sessions.

### E3. Reception double-count for nodes with bad clocks on cache miss
`src/ingest/pipeline.ts:42-43,104`, `db/migrations/0001_init.sql:69` (`uq_rx(packet_id,gateway_id,rx_time)`).
When a node RTC is implausible, `rx_time = receivedAt` (wall clock), which differs between two
deliveries of the same packet+gateway. If the in-memory `DedupCache` misses (eviction, TTL, restart),
the DB backstop keyed on `rx_time` no longer collapses the duplicate reception. Fix: for the fallback
case, key reception idempotency on `(packet_id, gateway_id)` or a deterministic `rx_time`.

### E4. Live map animates MQTT-only self-uplinks as RF pulses (path honesty)
`src/ingest/pipeline.ts:170-181` emits a `reception` SSE event for every class including `mqtt_self`
and injected (non-RF), while the link-aggregate step just above deliberately excludes them
(`pipeline.ts:139-142`). The client classifies `direct = hopStart===hopLimit` (`LiveMap.tsx:436`), so
a `mqtt_self` copy animates as a direct pulse + gateway ring though no gateway heard it over the air,
contradicting the "observed receptions only" footer (`LiveMap.tsx:521`). Fix: filter the SSE emit to
RF classes, matching the exclusion already at `pipeline.ts:140`.

### E5. Static map draws relayed links as a direct gateway-to-node line (path honesty)
`src/components/MeshMap.tsx:181-185` draws a `status='relayed'` link (from `queries.ts:697-701`) as a
single straight gateway-to-node line, asserting an adjacency never heard directly. The live map does
this correctly (resolves the relay hop or draws nothing, `src/lib/livemap.ts:48-72,105-115`); the
static map has no relay resolution or disclaimer. Fix: resolve the relay hop as the live map does, or
annotate relayed lines as topology-only.

### E6. Position estimation degeneracy test uses an absolute threshold in the wrong units
`src/lib/position.ts:181-191`: the collinearity guard is `Math.abs(det) < 1e-6`, but `det` is built
from sums in meters^2 (often 1e8+). Only exactly-collinear inputs are caught; near-collinear geometry
passes and the linear solve produces a position far outside the receiver hull. Fix: normalized/
relative condition, e.g. `Math.abs(det) < 1e-6 * Math.max(sxx*syy, 1)`, or a condition-number check.

### E7. Tier-3 confidence radius understates true uncertainty
`src/lib/position.ts:193-198`: the radius is the RMS of geometric residuals only and ignores the
dominant RSSI-to-distance model error (2-5x at 915 MHz, per the module's own docstring). Three
mutually consistent but wrong ranges yield a small RMS and a confidently precise circle over an
imprecise estimate. The estimate is correctly labeled "estimated" (good), but the numeric bound is
optimistic. Fix: fold path-loss uncertainty into the radius (variance-derived multiplier or a floor
proportional to mean estimated range).

### E8. Node RF transport pays a full config dump per send and contends with ingest RX
`src/node/transport.ts:44-89`: every RF send opens a fresh TCP connection and runs the full
`want_config` handshake (node dumps the entire NodeDB) before accepting the packet, then waits 1.5s
and closes. With auto-traceroute + admin scanner + text this is heavy and races the ingest RX
connection to the same node (`ECONNRESET`, comment at `transport.ts:29-30`); C1 overlap makes
concurrent sessions likely. Fix: the C1 re-entrancy guard is the primary mitigation; a single
persistent-with-heartbeat session would remove the per-send dump.

### E9. Frame length header has no sanity cap
`src/node/frame.ts:33-35` reads a 16-bit length and buffers up to 65535 bytes before emitting; a
corrupt length after valid magic bytes wastes a buffer cycle before self-healing. Low impact; add a
max-frame sanity cap.

### E10. Lagging SSE client silently loses events
`src/db/queries.ts:379` caps the tail at 200/poll and `src/worker/retention.ts:29-30` deletes
`live_events` older than 10 min. A client behind by more than the retention window loses rows with no
gap-detection signal. Low likelihood; add a "you missed events, reload" marker.

### E11. Manual TX enqueue APIs have no idempotency key
`src/app/api/v1/tx/message/route.ts:33` (and `/tx/request`, `/tx/traceroute`): one row per call, so a
double-clicked submit sends twice. Proactive enqueuers dedup via `created_by` markers; the manual
paths do not (`/tx/traceroute` at least has a per-target cooldown). Add a client-supplied idempotency
token or a short dedup window.

### E12. Channel-util guard fails open without telemetry
`src/lib/txstate.ts:15-18`: `channelUtilOk` returns true when `util==null`, and `recentChannelUtil()`
is null when no node reported `chan_util` in 15 min. On a small or MQTT-only mesh the
`tx.max_channel_util` cap is a silent no-op though the admin UI presents it as a hard cap. Document,
or offer a fail-closed option.

---

## 4. Actionable Refactoring Roadmap

### Immediate Fixes (correctness, data loss, transmission safety)
1. **C1** re-entrancy guard on all worker `setInterval` loops + atomic `queued -> sending` outbox
   claim. This one change also closes the rate-limit bypass, C2's cancel-resurrection, and the C2
   crash-re-send by construction.
2. **C5** `client.end(true)` on failed MQTT connect; set `connectedBrokerId` only after connect.
3. **C4** cap the ingest queue with backpressure or a counted drop; no silent OOM.
4. **C3** strengthen the decrypt validity gate (known portnum + non-empty payload); do not accept
   `portnum===0`/empty as decoded.
5. **C7** move `bumpTopic` off the per-message path into an aggregated/timed flush.
6. **P2** add the four `source_packet_id` indexes and the `node_telemetry` metric-leading index +
   time bounds (migration only, no logic change, immediate dashboard relief).
7. **C10** clamp records: `hop_start <= 7`, link distance <= ~300 km, exclude muted/position-ignored.
8. **C9** SSE running-flag + `desiredSize` backpressure.

### Medium-Term Refactors (scale and robustness)
1. **C6/P3** worker-maintained `latest_telemetry_per_node` and a bounded/recency-aware "heard_by"
   aggregate; serve `/map` hops from `reception_rollup_hour` instead of raw receptions.
2. **C8/E3** replace the floored wall-clock `dedup_bucket` with a rolling first-seen lookup so
   gateway copies never split across a boundary, and make reception idempotency clock-independent.
3. **P1** chunk batch transactions to a fixed size; **P4** multi-row `live_events` inserts.
4. **E1** scope the ingest reload to the broker/key/node config subset instead of the global rev.
5. Partition + retain the currently-unbounded derived tables: `node_rollup_hour`
   (`0001_init.sql:337-352`), `reception_rollup_day`, `text_message`, `node_position_events`,
   `link_events` (none partitioned or pruned today; `src/worker/retention.ts` covers only the
   receptions-scale set).
6. **P5** single shared SSE tailer fanning out to all connections.
7. **E8/E4/E5** node-transport persistent session; SSE emit filtered to RF classes; relay-resolve or
   annotate relayed lines on the static map.
8. **E6/E7** normalized degeneracy test and honest confidence radius in position estimation.

### Best Practices to Adopt
1. Treat every attacker-controlled field (`hop_start`, self-reported `node_positions`, node id) as
   untrusted at the analytics boundary: shared plausibility clamps before any monotonic record or
   leaderboard.
2. Make the outbox a true state machine with an explicit `sending` state and compare-and-swap
   transitions; never blind-write terminal states.
3. Bound every in-memory structure (ingest queue, SSE stream buffer, per-broker transport map) and
   close every long-lived connection on shutdown (`brokerTransports` currently leaks on exit,
   `src/worker/tx.ts:16-22` vs `src/worker/index.ts:149-150`).
4. Throttle transport connect/publish-failure logging the way gate reasons are already throttled
   (`src/worker/tx.ts:39-44`), so a broker outage does not flood `tx_log` (`src/tx/transport.ts:30`,
   `src/worker/tx.ts:213-214`).
5. Only the worker creates partitions; if it is down longer than `precreate_ahead_days` (7) while
   ingest writes, rows pile into `pmax` and the next `REORGANIZE` is a slow full rewrite. Have ingest
   also call `ensurePartitions`, or raise the lookahead.
6. Prefer partition-key predicates over surrogate-`id` filters on time-partitioned tables
   (`getPacketDetail`, `listPackets` sort by `id` touch all partitions, `queries.ts:166-182,36-58`).

---

*End of audit. All findings are read-only observations with file and line citations; no source was
modified.*
