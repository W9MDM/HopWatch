# Transmit (TX) subsystem

HopWatch is passive by default. A fresh install observes only and publishes nothing. The TX
subsystem (v2.0) adds an opt-in, audited, rate-limited path to send to the mesh. This document
covers the safety model and requirements. All TX settings are managed in `/admin/tx`
(database-backed, hot-reloaded); defaults live in the config schema (`src/config/schema.ts`)
and can be seeded from YAML on first run, but the database is the source of truth after that.

## Turning it on (three gates)

TX only happens when ALL of these hold:

1. `tx.enabled` is true (off by default).
2. `tx.from_node` is set to a stable u32 node id (your virtual identity on the mesh).
3. An admin has **armed** the queue in `/admin/tx`, and `tx.dry_run` is off.

With `tx.dry_run` on (the default when you first enable), the full pipeline runs including
protobuf encode, but nothing is published: outbox rows land in state `dry_run`. Flip dry-run
off only when you have confirmed the encoded traffic looks right.

**Disarm is the kill switch.** It halts the queue on the worker's next tick (~10s), no
restart. Queued rows stay queued and resume when re-armed. Confirmation reconciliation keeps
running while disarmed, so acks of already-sent traffic still land.

## Transports

`tx.transport` selects how packets leave HopWatch:

- **`mqtt`** (default): HopWatch publishes an encrypted `ServiceEnvelope` to the downlink topic
  `<root>/2/e/<channel>/!<from_node>` on the broker chosen by `tx.broker_id` (empty = the
  first enabled broker). `<root>` is that broker's configured root topic (e.g. the firmware
  default `msh`, or a community root like `msh/US/IN/NWI`); it must match the gateway's root
  exactly, because the firmware subscribes to `<root>/2/e/<channel>/+` and the MQTT `+` wildcard
  matches exactly one level. A row whose broker has no resolvable root fails rather than
  publishing where nothing is listening. On an encrypted packet `MeshPacket.channel` carries the
  8-bit channel hash (`xorHash(name) ^ xorHash(psk)`), which is what a receiver matches against
  its own channels; the channel index is used only on the `node` transport. A **downlink-enabled
  gateway** must also be present on the mesh: some gateway has to be configured to rebroadcast
  MQTT downlink on the target channel, or packets publish to the broker but never hit the air.
- **`node`**: HopWatch encodes a `ToRadio` frame and sends it over a direct link to a local
  Meshtastic node (`node.host` / `node.port`, default TCP 4403). This removes the
  downlink-gateway dependency. The packet is sent DECODED (plaintext) with the target channel's
  index; the node encrypts and transmits it, exactly as the phone app does. HopWatch resolves the
  channel name to its node index (cached), falling back to the primary channel (index 0).

## What can be sent

Outbox `kind` values:

- `text` (broadcast text), `dm` (direct message to a node)
- `traceroute`
- `position_req`, `telemetry_req` (request a node's position/telemetry)
- `announce` (optional NODEINFO broadcast of HopWatch's own name; see below)

`dm`, `traceroute`, `position_req`, and `telemetry_req` require a target node and are refused
for muted nodes.

## How a send flows

Nothing publishes directly. Every send is a row in `tx_outbox`:

1. An API call (`/api/v1/tx/*`) or UI action inserts a `queued` row, attributed to the user.
2. The worker drains the outbox every ~10s and enforces, in order: armed + identity set,
   per-row backoff, global rate limits, mute refusal, channel-util guard, hop-limit cap.
3. It encodes the packet (`src/meshtastic/encode.ts`). For the mqtt transport it encrypts for
   the channel with the channel key and publishes the `ServiceEnvelope`; for the node transport
   it sends a decoded `ToRadio` frame (channel index set) and the node encrypts and transmits.
4. Delivery confirmation is implicit: our own packet uplinked back by the mesh gateways
   arrives through normal ingest. Matching on packet id + from-node, each distinct gateway
   that heard it becomes a row in `tx_confirmations`; the outbox row goes `sent` -> `heard`.
   An explicit `ROUTING_APP` ack addressed to us upgrades it to `acked`.

### Outbox states

`queued` -> (`dry_run` when dry-run is on, else `sent`) -> `heard` -> `acked`. Plus:

- `held`: channel utilization exceeded `tx.max_channel_util`; the row is retried on a later
  tick.
- `failed`: encode or publish failed after retries (up to 5 attempts with backoff), or the
  target became muted.
- `cancelled`: a user cancelled a still-queued row via `/api/v1/tx/outbox/[id]/cancel`.

## Requirements and limits

- **A known channel key** is required to encrypt for a channel; the compose box only offers
  channels with a configured key. On the MQTT transport the worker fails (after retries) any
  outbox row whose channel has no configured key rather than publish it unencrypted; an
  intentionally unencrypted channel is still possible by storing an explicit zero key. The
  node transport needs no key (the station node encrypts on its side).
- Defaults (all editable in `/admin/tx`): `tx.rate_limit.per_minute` 3 and
  `tx.rate_limit.per_hour` 30, `tx.max_channel_util` 25%, `tx.max_hop_limit` 3,
  `tx.traceroute_cooldown_s` 300 (5 min per node).
- HopWatch refuses to DM, traceroute, or probe a muted node.
- **The station node serves one client at a time.** The firmware's TCP API server force-closes the
  existing session as soon as it accepts a new connection (`ServerAPI.cpp`
  `APIServerPort::runOnce`), and HopWatch opens that port from three processes: the persistent ingest
  RF receive stream, every `node`-transport publish in the worker, and admin config read/write in
  web. They are serialized by a single-row database lease (`node_lease`, migration `0048`), since
  processes may only coordinate through the database (Rule 5). A TX publish or config operation takes
  the lease, waits about a second for the receive connector to let go, does its work and releases;
  the connector polls the lease and stands down rather than reconnecting into a fight (a reconnect
  used to evict the TX handshake, whose retry evicted the connector again). A yield is not counted as
  a reconnect, and `GET /api/v1/admin/diagnostics` reports the current holder as
  `liveness.node_lease_holder`. If the node is busy for 30 seconds the operation fails with "station
  node is busy" rather than barging in.
- **A node that closes the stream is a failure, not a success.** A `node`-transport publish is only
  recorded as `sent` once the `ToRadio` frame has actually been written; a close before that fails
  the row and retries, instead of logging a transmit that never happened.
- **The receive stream reconnects on its own, and can be kicked.** After a drop it retries with
  exponential backoff: 1s, 2s, 4s, 8s, 16s, then every 30s indefinitely, resetting to 1s once a TCP
  connection is established. A deliberate yield to the lease does not count as a fault and resumes
  about 250ms after the lease clears. `POST /api/v1/admin/node/reconnect` (the "Connect now" button
  in `/admin/tx`) abandons the current wait and reconnects immediately; it reaches the ingest process
  as a `service_control` row, picked up on the lease poll that already runs every second. It is a
  receive-side action and does not transmit, so the arm state does not gate it.
- **The receive stream is kept alive and watched.** A `ToRadio{heartbeat}` (nonce 0, a keepalive the
  node answers off-air, never nonce 1, which would make the node broadcast its nodeinfo over RF
  outside the outbox) goes out every two minutes, because the firmware drops a client that has been
  silent for 15 minutes and only client-to-node traffic counts. TCP keepalive plus a receive watchdog
  cover a node that vanishes without a FIN, and the station node reports as connected only while it
  is actually producing frames.
- **A resolvable MQTT topic root** is required on the `mqtt` transport. It comes from the target
  broker's root topic, and a row whose broker has no resolvable root fails rather than publishing
  to a topic no gateway subscribes to.
- `tx.ok_to_mqtt` (default true, toggle in `/admin/tx`) sets the OK-to-MQTT bit
  (`Data.bitfield` bit 0) on what HopWatch sends, so gateways and OK-to-MQTT-honoring bridges
  will uplink our own traffic. The bit rides inside the encrypted payload, so a receiver only
  sees it after decrypting with the channel key.

## Automatic TX behaviors (off by default)

These require TX enabled + armed + dry-run off (they must actually send):

- **NODEINFO announce** (`tx.announce_interval_s` > 0): periodically broadcasts HopWatch's own
  `tx.node_long_name` / `tx.node_short_name` so the mesh has a name for the station.
- **Auto-responder** (`tx.auto_responder.enabled`): replies to inbound text matching any of
  `tx.auto_responder.triggers[]` (each `{pattern (regex), reply (template), reply_mqtt (template),
  reply_via, channels}`; first match wins). `channels` scopes a trigger to specific channels by name
  (empty = any), so a trigger can reply on-channel on the Testing channel without also firing on the
  main channel. `reply` is used when the message was heard over RF; `reply_mqtt`
  (when non-blank) replaces it for MQTT-heard messages, which carry no RSSI/SNR so an RF template's
  `{rssi}/{snr}` would render as `?`. `reply_via` picks how each reply is sent: `match` (same as the
  incoming: DM->DM, channel->channel broadcast), `dm` (always private to the sender), or `channel`
  (always broadcast on the message's channel). `reply_transport` (`match`/`both`/`fixed`) picks which
  link the reply rides, and `reply_channel` sets the broadcast channel.
  `respond_to_dm`/`respond_to_channel` still gate which inbound messages are considered.
- **Welcome new nodes** (`tx.auto_responder.welcome`): greets each node the first time it is heard
  (once per node, deduped by the outbox marker `auto-welcome:<id>`), if it is within `within_hops`
  RF hops (0 = only nodes heard directly). Only newcomers first seen in the last hour are greeted,
  so enabling it does not flood-welcome the existing node DB. `reply_via` is `dm` (to the newcomer)
  or `channel` (broadcast). A DM rides the keyed channel the newcomer was last heard on, falling
  back to `channel`, then the first keyed channel; a channel greeting uses `channel` first with
  the same fallbacks. Uses the same reply template vars.
- **Spam nudge** (`tx.auto_responder.spam_nudge`): when a node repeats the same short message at
  least `threshold` times within `window_minutes` (a stuck tester spamming the mesh), send it ONE
  polite DM (deduped by the outbox marker `spam-nudge:<id>`), then stay silent for
  `cooldown_minutes` per node so the nudge never becomes spam itself. The DM goes out on the
  transport the node was last heard on (RF via the station node, else the broker it arrived on) and
  obeys every TX rail and the audit log. Off by default. Template vars: `{short} {name} {count} {msg}`.
  Replies to DMs (`respond_to_dm`) and/or channel broadcasts (`respond_to_channel`), rate-paced by
  a per node+trigger `cooldown_s`. Each `pattern` is a case-insensitive regex matched ANYWHERE in
  the message (`\btest\b` fires on "this is a test"; `^test$` only on exactly "test"). Reply
  templates support `{name} {short} {id} {rssi} {snr} {hops} {via}` (RF or MQTT) `{msg} {count}
  {time}` (e.g. `pong to {short}: {rssi} dBm / {snr} dB, {hops} hop(s) via {via}`).
- **Auto-traceroute** (`tx.auto_traceroute.enabled`): emits at most one batch every
  `tx.auto_traceroute.send_every_minutes` (default 5) and never while a traceroute is still queued
  (no stacking); targets only active nodes whose route is missing or older than
  `tx.auto_traceroute.interval_hours`, capped at `tx.auto_traceroute.max_per_run` per batch,
  limited to nodes seen within `tx.auto_traceroute.max_active_age_hours`. `tx.auto_traceroute.transport` (`rf`|`mqtt`, default
  `rf`) picks the station node (RF) or a broker downlink; `only_routers` traces just
  router/repeater infrastructure. Sent traceroutes and their state show in the "Sent traceroutes"
  log on the `/traceroutes` page.

## Remote admin scanner

`tx.admin_scanner` (Admin -> Settings -> Remote admin) periodically sends a DeviceMetadata admin
request (`admin_probe` outbox kind) to recently-heard nodes through the **station node**, which
PKI-encrypts it as an authorized admin (HopWatch cannot build the PKI itself, so this needs a
station node and only ever probes over the node transport). A node that answers is administrable;
the ingest daemon records it in the **persistent** `remote_admin` table when the response arrives
on the node RX stream. Unlike a live "recently scanned" view, recorded nodes stay (with first/last
OK time, success count, firmware, hardware, role) until an admin forgets them. Settings: `enabled`,
`interval_hours` (retry nodes that have not answered), `max_per_run`, `max_active_age_hours`, and
`reconfirm_hours` (re-verify already-confirmed nodes only this often; 0 = never re-probe a node
that already said yes). Probing is gated by TX enabled + armed + dry-run off; a node only answers
if this station is an authorized admin on it.

## Pacing

The outbox drains at `tx.rate_limit` (per-minute / per-hour). Proactive enqueuers (auto-traceroute,
remote-admin scanner, welcome) back off while a backlog is draining, so they never queue faster
than sends leave and pile up. Reactive sends (user messages, auto-responder replies) and
safety-critical weather alerts are not throttled this way. If a legitimate backlog persists, raise
`tx.rate_limit.per_minute` / `per_hour`, or reduce auto-traceroute frequency.

## Debugging

- The Transmit tab shows a **TX debug log**: the worker's send-pipeline trace (gate reasons,
  encode, transport, topic/broker, publish, success/failure), so operators without shell access
  can see exactly what happened. It is backed by the `tx_log` table (kept ~3 days), mirrored to
  stdout, and read via `GET /api/v1/tx/log`. The outbox table also shows the transport (Via) and
  per-row error (Detail) inline.

## Audit and RBAC

- Every outbox row (including dry-run and failed sends) is retained as the audit log, with
  the user who queued it, and is visible in `/admin/tx`.
- Anonymous read-only users can never send. API tokens need the `can_tx` flag; a role with
  `can_tx: true` grants it to its members/tokens. Admin sessions can send and manage the queue.

## Scope

Out of scope: publishing on behalf of other nodes, rebroadcasting observed traffic, remote
channel/key management, and store-and-forward. HopWatch speaks only as its own configured
node.


### Auto-responder reply channel

`tx.auto_responder.reply_channel` (blank by default) sets the channel a NON-DM reply is broadcast
on. Blank keeps the historical behaviour: reply on the channel the trigger arrived on. Set it when
the station node can DECODE a channel it is not a MEMBER of, i.e. HopWatch holds the channel key but
the node itself has no such channel, so it cannot transmit there and a channel reply would be
refused. Pinning it to a channel the node actually holds (e.g. `LongFast`) makes every channel reply
land regardless of where the trigger was heard. DM replies (`reply_via: dm`, e.g. a ping) are
unaffected: they go straight back to the sender.

`tx.auto_responder.reply_transport` (default `match`) chooses the LINK a reply goes out on,
separately from whether it is a DM or a channel broadcast: `match` answers on the transport the
trigger was heard on (RF via the station node, or MQTT published to the broker it arrived on, so a
downlink gateway near the sender re-airs it), `both` sends on RF and MQTT, `fixed` always uses
`tx.transport`. `match` is what reaches a node that is not an RF neighbour: a "test" heard only over
MQTT cannot be answered by an RF broadcast, so an RF-only reply never reaches that sender.

Each trigger has a `reply` (used when the trigger was heard over RF) and an optional `reply_mqtt`
(used when heard over MQTT, where there is no RF `{rssi}`/`{snr}` -- they would render as `?`). Blank
`reply_mqtt` falls back to `reply`. The worker chooses the template by how the trigger arrived, so an
MQTT-heard node gets sensible text with no stray `?`.
