import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { getChannelKeys, getRuntimeBrokers } from "../db/settings.ts";
import { effectiveTopicRoot } from "../meshtastic/topic.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { encodeTx } from "../meshtastic/encode.ts";
import { enqueueTx } from "../db/tx.ts";
import { getPool } from "../db/client.ts";
import { mqttFor } from "./tx.ts";
import type { TxTransport } from "../tx/transport.ts";
import type { HopWatchConfig } from "../config/schema.ts";

interface Candidate {
  id: number; from_node_id: number; short_name: string | null; long_name: string | null;
  channel_id: string | null; channel_index: number | null; body: string; source_packet_id: number;
  mesh_packet_id: number | null; ok_to_mqtt: number | null; is_reaction: number | null;
  on_rf: number; on_mqtt: number;
}

/**
 * RF<->MQTT message patcher. Makes HopWatch a cross-transport bridge like a Meshtastic gateway,
 * with a hold timer that prevents doubling: a message is only patched to the other transport if,
 * after `patch_hold_seconds`, it has NOT already arrived there on its own (a real gateway or the
 * station node's own uplink/downlink, or it was simply heard on both). Direction rules:
 *   - RF-only text  -> faithful MQTT uplink (original sender preserved, re-encrypted). Not a TX.
 *   - MQTT-only text -> re-originated onto RF as HopWatch's own node via the armed tx_outbox.
 * Never patches our own TX node (loop guard), and marks every candidate handled exactly once.
 */
export async function runMessagePatch(cfg: HopWatchConfig, transports: { mqtt: TxTransport; node: TxTransport }): Promise<number> {
  const b = cfg.bridge as unknown as {
    enabled: boolean; armed: boolean; channels: string[]; local_broker_id: string;
    rf_to_mqtt: boolean; mqtt_to_rf: boolean; patch_hold_seconds: number; require_ok_to_mqtt: boolean;
  };
  if (!b.enabled || !b.armed) return 0;
  if (!b.rf_to_mqtt && !b.mqtt_to_rf) return 0;
  const hold = Math.min(600, Math.max(3, Number(b.patch_hold_seconds) || 20));
  const ourNode = cfg.tx.from_node || 0;

  const rows = await query<Candidate>(
    // COALESCE the channel from the packets row: the side tables are written once per logical
    // packet, so the text row keeps whatever the first DECODING copy knew, while the packets row is
    // backfilled by every later copy. Without this an RF-only message whose text row predates the
    // channel backfill still has no channel and would be refused for want of a key.
    `SELECT tm.id, tm.from_node_id, n.short_name, n.long_name,
            COALESCE(tm.channel_id, p.channel_id) AS channel_id, tm.channel_index, tm.body, tm.source_packet_id,
            p.mesh_packet_id, p.ok_to_mqtt, tm.is_reaction,
            EXISTS(SELECT 1 FROM receptions r WHERE r.packet_id=tm.source_packet_id AND r.transport='rf')   AS on_rf,
            EXISTS(SELECT 1 FROM receptions r WHERE r.packet_id=tm.source_packet_id AND r.transport='mqtt') AS on_mqtt
     FROM text_message tm
     LEFT JOIN nodes n ON n.node_id = tm.from_node_id
     LEFT JOIN packets p ON p.id = tm.source_packet_id
     WHERE tm.bridged_at IS NULL AND tm.source_packet_id IS NOT NULL
       AND tm.observed_at <= (UTC_TIMESTAMP() - INTERVAL ? SECOND)
       AND tm.observed_at >= (UTC_TIMESTAMP() - INTERVAL 15 MINUTE)
       AND tm.from_node_id <> ?
     ORDER BY tm.id ASC LIMIT 100`,
    [hold, ourNode],
  );
  if (rows.length === 0) return 0;

  const keys = new Map((await getChannelKeys()).map((k) => [k.name, k.key]));
  let patched = 0;

  for (const row of rows) {
    const chan = row.channel_id ?? "";
    // A tapback reaction is metadata about another message, not a message. Re-originating one
    // onto the other transport would post a bare emoji as if someone had typed it.
    if (row.is_reaction) { await mark(row.id); continue; }
    // Channel allowlist (empty = all decodable text channels).
    if (b.channels.length > 0 && !b.channels.includes(chan)) { await mark(row.id); continue; }
    const onRf = !!row.on_rf, onMqtt = !!row.on_mqtt;
    try {
      if (onMqtt && !onRf && b.mqtt_to_rf) {
        // MQTT-only: re-originate onto RF as our node. tx_outbox applies arm + rails + audit.
        //
        // The outbox row is pinned to the node transport, so without a station node there is no way
        // to reach RF at all and every candidate would become a failed row with no explanation of
        // the real cause. Refuse on the record instead.
        if (!cfg.node.host) {
          await skip(row, "no station node configured (node.host), so there is no RF transmitter");
          continue;
        }
        if (!cfg.tx.enabled || !cfg.tx.armed) {
          await skip(row, "TX is disabled or disarmed, so nothing can be re-originated onto RF");
          continue;
        }
        const who = row.short_name || row.long_name || formatNodeId(row.from_node_id);
        await enqueueTx({
          createdBy: "bridge:mqtt-to-rf", transport: "node", kind: "text",
          channelId: chan, toNode: null, fromNode: ourNode,
          payloadText: `${who}: ${row.body}`.slice(0, 220),
          hopLimit: cfg.tx.default_hop_limit, wantAck: false,
        });
        await logPatch("mqtt_to_rf", "", row, chan, "tx_outbox");
        patched++;
      } else if (onRf && !onMqtt && b.rf_to_mqtt) {
        // RF-only: faithful gateway uplink to the local broker (original sender + re-encrypt).
        //
        // "Faithful" is the whole point: this republishes a THIRD PARTY's message, so it must
        // carry their consent bit, their packet id, and their real hop counts. Inventing any of
        // those makes HopWatch assert things about someone else's traffic that are not true.

        // The sender's OK-to-MQTT bit is their consent to be uplinked. By default we honour it and
        // skip a node that did not set it (matching the federation bridge and ingest/index.ts). An
        // operator can turn `bridge.require_ok_to_mqtt` off to uplink non-consenting senders too --
        // appropriate for a PRIVATE broker, but on the public Meshtastic MQTT it republishes traffic
        // from people who opted out, which is exactly what the bit exists to prevent. Even then we do
        // NOT forge consent: the re-encoded copy carries the sender's REAL bit (see okToMqtt below),
        // so a downstream gateway that honours the flag will not propagate it further.
        if (b.require_ok_to_mqtt && !row.ok_to_mqtt) {
          await skip(row, "sender did not set OK-to-MQTT (bridge.require_ok_to_mqtt is on)");
          continue;
        }

        // Without the channel key we would publish a third party's text in CLEARTEXT on the
        // encrypted topic: readable by anyone with topic access, and dropped by real receivers.
        const chanKey = keys.get(chan) ?? "";
        if (!chanKey) {
          await skip(row, `no channel key for "${chan || "(none)"}", refusing a plaintext uplink`);
          continue;
        }

        // Publish to the broker whose topic root we are about to build the topic from. The shared
        // transport resolves to `tx.broker_id || brokers[0]`, which is a DIFFERENT broker whenever
        // the operator points the bridge at a private broker and TX at a public one: a third
        // party's message then went to the wrong server entirely.
        const root = await localBrokerRoot(b.local_broker_id);
        if (!root) {
          await skip(row, b.local_broker_id
            ? `bridge.local_broker_id "${b.local_broker_id}" has no resolvable topic root`
            : "bridge.local_broker_id is not set, so there is nowhere to uplink to");
          continue;
        }

        const rf = await rfReception(row.source_packet_id);
        const gw = rf?.gateway_id ?? row.from_node_id;
        const enc = await encodeTx({
          kind: "text", fromNode: row.from_node_id, toNode: null,
          channelIndex: row.channel_index ?? 0, channelName: chan, channelKey: chanKey,
          text: row.body, wantAck: false,
          // Preserve the original (from, id) so the mesh's dedup still recognizes this as the
          // same packet. A fresh random id would make every gateway treat it as a new message
          // and re-inject it onto RF, doubling it for every user.
          packetId: row.mesh_packet_id ?? undefined,
          // Report the hops it actually travelled, not a fabricated 0-hop direct.
          hopLimit: rf?.hop_limit ?? cfg.tx.default_hop_limit,
          hopStart: rf?.hop_start ?? undefined,
          // The sender's ACTUAL consent bit, never forged. When require_ok_to_mqtt is on this is
          // always true (we skipped the rest above); when it is off we may be uplinking a node that
          // set it false, and we preserve that so we do not assert consent it never gave.
          okToMqtt: !!row.ok_to_mqtt,
          topicRoot: root,
          gatewayNode: gw,
        });
        await mqttFor(b.local_broker_id, transports.mqtt).publish(enc.topic, enc.bytes);
        await logPatch("rf_to_mqtt", b.local_broker_id, row, chan, enc.topic);
        patched++;
      }
      // Heard on both (or nothing to do): already carried across; just mark handled.
    } catch (e) {
      console.error(`[patch] message ${row.id} failed: ${(e as Error).message}`);
    }
    await mark(row.id);
  }
  return patched;
}

async function mark(id: number): Promise<void> {
  await query(`UPDATE text_message SET bridged_at=? WHERE id=?`, [toMysqlUtc(new Date()), id]);
}

/**
 * Refuse one message, on the record. Every skip here is a message the operator ASKED to be bridged
 * and that silently was not, so it goes to bridge_log (which /bridge and the diagnostics bundle
 * read) instead of only to a console line nobody scrapes.
 */
async function skip(row: Candidate, reason: string): Promise<void> {
  console.error(`[patch] message ${row.id} not uplinked: ${reason}`);
  await logPatch("skip", "", row, row.channel_id ?? "", reason);
  await mark(row.id);
}

type PatchDirection = "rf_to_mqtt" | "mqtt_to_rf" | "skip";

async function logPatch(direction: PatchDirection, toBroker: string, row: Candidate, channel: string, dest: string): Promise<void> {
  await getPool()
    .execute(
      `INSERT INTO bridge_log (bridged_at, direction, from_broker, to_broker, from_node_id, mesh_packet_id, channel_id, topic, dest_topic)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      [toMysqlUtc(new Date()), direction, "rf", toBroker, row.from_node_id, row.mesh_packet_id ?? 0, channel || null, "rf", dest.slice(0, 255)],
    )
    .catch((e) => console.error(`[patch] bridge_log failed: ${(e as Error).message}`));
}

/** The RF reception we are uplinking on behalf of: which gateway heard it and the hop counters
 * it carried, so the uplink reports the path the packet actually took. */
async function rfReception(packetId: number): Promise<{ gateway_id: number; hop_start: number | null; hop_limit: number | null } | null> {
  const [r] = await query<{ gateway_id: number; hop_start: number | null; hop_limit: number | null }>(
    `SELECT gateway_id, hop_start, hop_limit FROM receptions WHERE packet_id=? AND transport='rf' LIMIT 1`,
    [packetId],
  );
  return r ?? null;
}

async function localBrokerRoot(brokerId: string): Promise<string | null> {
  if (!brokerId) return null;
  const b = (await getRuntimeBrokers()).find((x) => x.id === brokerId);
  if (!b) return null;
  return effectiveTopicRoot(b.root_topic, b.topics).root || null;
}
