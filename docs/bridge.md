# MQTT text bridge

An opt-in, off-by-default feature that federates **text messages** between MQTT brokers:
it forwards `TEXT_MESSAGE_APP` packets from your local broker to configured peer brokers and
vice versa, so chat flows together across servers. It deliberately does nothing else.

## What it does and does not do

- **Only text messages.** `TEXT_MESSAGE_APP` (port 1) packets only. No telemetry, position,
  nodeinfo, traceroute, or other traffic is ever bridged (`bridge.text_only`, default true).
- **Only sender-approved packets.** Only packets whose sender set the Meshtastic OK-to-MQTT bit
  (`Data.bitfield` bit 0) are forwarded (`bridge.require_ok_to_mqtt`, default true).
  Packets from older firmware that do not set the bit are not bridged. The bit lives on the inner
  `Data`, i.e. inside the encrypted payload, so it is only readable once a channel key decrypts the
  packet: an undecryptable packet reports "not approved" and fails this gate closed.
- **Local to peers, and peers to local, never peer to peer.** One configured broker is "ours"
  (`bridge.local_broker_id`); the rest you select are peers (`bridge.peer_broker_ids`). Text
  from the local broker is published to each peer; text from a peer is published to the local
  broker (and shown in HopWatch). Two peers are never bridged to each other.
- **Loop-guarded.** Each `(from, packet id)` is forwarded at most once per 5-minute window, so a
  packet that echoes back through a peer is dropped rather than re-forwarded. Id-less packets
  are never bridged.
- **Payload unmodified, topic rewritten to the destination.** The original MQTT payload (the
  encrypted `ServiceEnvelope`) is forwarded byte-for-byte; the bridge decrypts only to check the
  port and approval bit. The topic is rewritten onto the destination broker's namespace: the
  destination's **root topic** replaces everything before the `/2/e/<channel>/<gateway>` suffix,
  so its subscribers actually receive the message instead of it landing under a foreign root.
- **Audited.** Every forward is written to `bridge_log` with both the source topic and the
  rewritten destination topic, and shown on the bridge admin page so the mapping is verifiable.

This is MQTT-layer, server-to-server federation, not an RF transmit, so it does not go through
the TX `tx_outbox` (see `docs/tx.md`). It is the one sanctioned exception to Rule 2's
"no rebroadcasting observed traffic," and only because it is gated to text + OK-to-MQTT.

## Turning it on

1. Add the peer brokers under `/admin/settings` (ingest) so HopWatch also receives their
   traffic. The bridge only works with brokers HopWatch is connected to. Set each broker's
   **Root topic** (e.g. `msh/US/IN/NWI`) there so forwarded messages are republished under the
   right namespace; leaving it blank derives the root from the broker's first subscribe topic.
2. Go to `/admin/bridge`:
   - Set **Enabled** (config gate) and **Armed** (runtime kill switch). Both must be on;
     disarming stops all forwarding within ~5s.
   - Pick the **local broker** (yours) and check the **peer brokers** to bridge with.
   - The **Topic rewrite** preview then shows exactly what maps to what: each broker's effective
     root (flagged `root set`, `derived`, or `no root`) and, per direction, a
     `source-root/2/e/<channel>/<gateway> -> dest-root/2/e/<channel>/<gateway>` line. A broker
     marked `derived` infers its root from its first subscribe topic; set an explicit Root topic
     on its broker config if it carries multiple region roots.
3. The ingest daemon hot-reloads the bridge config on its ~5s settings poll.

## Settings (`bridge.*`, DB-backed, admin UI)

| Key | Default | Description |
|---|---|---|
| `bridge.enabled` | `false` | Master switch. |
| `bridge.armed` | `false` | Runtime kill switch; forwards nothing until armed. |
| `bridge.text_only` | `true` | Forward only `TEXT_MESSAGE_APP` packets. |
| `bridge.require_ok_to_mqtt` | `true` | Forward/uplink only packets whose sender set OK-to-MQTT. Governs BOTH the federation bridge AND the RF->MQTT patcher. Turn off to republish senders who did not consent (see caution). |
| `bridge.direction` | `both` | `both`, `out` (local to peers only), or `in` (peers to local only). |
| `bridge.channels` | `[]` | Channel names to bridge; empty = all decodable text channels. |
| `bridge.local_broker_id` | `""` | The configured broker that is "ours". |
| `bridge.peer_broker_ids` | `[]` | Configured brokers to bridge text with. |

## RF cross-link (station node)

With a station node connected (`node.host`) and `node.rx_enabled` on, HopWatch can also patch text
between RF and MQTT like a Meshtastic gateway, gated by `bridge.enabled` + `bridge.armed`:

- **`bridge.rf_to_mqtt`** (default false): RF-heard text is published to the local broker as a
  faithful gateway uplink: the original sender is preserved and the payload re-encrypted with the
  channel key. MQTT is not the air, so this is not a transmit and does not use `tx_outbox`.
- **`bridge.mqtt_to_rf`** (default false): MQTT-heard text is **re-originated as HopWatch's own TX
  node** (`sender: message`) and transmitted onto RF through the armed `tx_outbox` -- it never
  spoofs the original sender's node id. It sends only when the TX subsystem is `enabled` + `armed`
  (dry-run first) and obeys every TX rail (rate limits, channel-util guard, mute list, hop cap) and
  the audit log.
- **`bridge.patch_hold_seconds`** (default 20): before patching a message across, wait this long;
  if it already reached the other transport on its own (a real gateway, or your node's own
  uplink/downlink, or it was simply heard on both), skip it. This is what stops HopWatch from
  doubling a message your node already bridges natively (e.g. LongFast).

The patcher runs in the worker: it only patches messages stranded on one transport after the hold,
never patches HopWatch's own TX node (loop guard), and marks each message handled once.

### Requirements, and what shows up when they are not met

Every patch attempt is recorded in `bridge_log`, visible on `/bridge` and in the admin diagnostics
bundle, with direction `RF to MQTT`, `MQTT to RF`, or `not bridged` plus the reason. A message the
operator asked to bridge and that was not is therefore visible, rather than only appearing as a
worker log line before being marked handled.

RF to MQTT needs all of:

- **A channel name on the message.** RF receptions get theirs from the station node's own channel
  table, which the receive stream learns from the `want_config` dump it already asks for. The node
  decrypts before handing a packet to the stream API and rewrites `MeshPacket.channel` to the local
  channel *index*, so the table is the only thing that can turn that back into the channel identity.
  A channel with no name of its own resolves the way the firmware resolves it, to the modem preset's
  display name (`LongFast`), because that string is what the hash and the MQTT topic use.
- **A configured channel key of that name**, since the uplink re-encrypts. Without it HopWatch would
  publish a third party's text in cleartext on an encrypted topic, so it refuses.
- **The sender's OK-to-MQTT bit** (when `bridge.require_ok_to_mqtt` is on, the default): a node that
  opted out is not uplinked. Turn the flag off to uplink non-consenting senders too. Even then the
  bit is never forged: the re-published copy carries the sender's REAL value, so a downstream gateway
  that honours OK-to-MQTT will not propagate it onward. See the caution below before disabling it.
- **`bridge.local_broker_id` set to a broker with a resolvable topic root.** The uplink publishes to
  that broker, not to `tx.broker_id`.

MQTT to RF needs a station node (`node.host`) and the TX subsystem `enabled` + `armed`, since it is a
real transmission through `tx_outbox`. It also requires the station node to actually have a channel
of that name: transmitting a message from an unknown channel on the node's primary channel instead
would put it on the wrong channel, so the outbox row fails rather than doing that.

## Cautions

MQTT-to-MQTT bridging can create packet loops and, via downlink-enabled gateways, inject remote
traffic onto local RF. The text-only + OK-to-MQTT gating and the loop guard mitigate this, but
only bridge servers you coordinate with, and keep it disarmed if in doubt.

Disabling `require_ok_to_mqtt` republishes traffic from senders who opted out of MQTT. This is a
reasonable choice for a PRIVATE broker you control (RF is public airwaves, and everyone on a private
club mesh may have agreed to full logging). It is NOT good citizenship on the public Meshtastic MQTT,
where it exposes people who set the "don't MQTT me" bit precisely to avoid that. HopWatch never forges
consent regardless, but the operator should point this at a private broker, not the public one.
