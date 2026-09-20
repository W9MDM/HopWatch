import { query } from "../db/client.ts";
import type { HopWatchConfig } from "../config/schema.ts";
import { matchesPattern, fillTemplate, pickReplyTemplate, triggerAllowedOnChannel } from "../lib/autoresponder.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { enqueueTx, outboxBacklog } from "../db/tx.ts";
import { getChannelKeys } from "../db/settings.ts";

// Every outbound message must ride a channel we hold a key for: the MQTT transport encrypts
// here (a missing key would mean a plaintext publish on a topic no gateway subscribes to),
// and the node transport resolves the channel index by name. Preference order: the channel
// the peer was heard on, then the configured channel, then the first keyed channel.
function pickChannel(keyed: Set<string>, ...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) if (c && keyed.has(c)) return c;
  return keyed.values().next().value ?? null;
}

/** The channel a non-DM auto-reply is sent on: the configured reply_channel if we hold its key,
 * else the channel the message arrived on, else the first keyed channel (null only when we hold no
 * keys, in which case the caller must not transmit). Exported for unit testing. */
export function pickReplyChannel(keyed: Set<string>, replyChannel: string | null | undefined, incoming: string | null | undefined): string | null {
  return pickChannel(keyed, replyChannel, incoming);
}

export interface ReplyTarget { transport: "node" | "mqtt"; brokerId: string | null }

/**
 * The link(s) an auto-reply goes out on. "match" answers on the transport the trigger was heard on
 * (RF -> the station node; MQTT -> the broker it arrived on, so a downlink gateway near the sender
 * re-injects it), which is what actually reaches a node that is not an RF neighbour. "both" sends on
 * each. "fixed" keeps the configured TX transport. Exported for unit testing.
 */
export function pickReplyTargets(
  mode: "match" | "both" | "fixed",
  heardRf: boolean,
  sourceBroker: string | null,
  txTransport: "node" | "mqtt",
  txBroker: string | null,
): ReplyTarget[] {
  const mqttBroker = sourceBroker ?? txBroker ?? null;
  if (mode === "both") return [{ transport: "node", brokerId: null }, { transport: "mqtt", brokerId: mqttBroker }];
  if (mode === "fixed") return [txTransport === "mqtt" ? { transport: "mqtt", brokerId: txBroker || null } : { transport: "node", brokerId: null }];
  return [heardRf ? { transport: "node", brokerId: null } : { transport: "mqtt", brokerId: mqttBroker }];
}

const AUTO = "auto-responder";
const BROADCAST = 0xffffffff;

interface Incoming {
  id: number; from_node_id: number; to_node_id: number | null; body: string; channel_id: string | null;
  long_name: string | null; short_name: string | null;
  rssi: number | null; snr: number | null; hops: number | null; via: string | null;
  source_broker: string | null;
}

/**
 * meshmonitor-style auto-responder. Replies to recent text messages that match a configured
 * trigger, echoing the observed link quality (RSSI/SNR/hops) via a reply template. Handles both
 * DMs to our node (private reply) and, optionally, channel broadcasts (on-channel reply). First
 * matching trigger wins; a per node+trigger cooldown sits on top of the outbox rate limits.
 */
export async function runAutoResponder(cfg: HopWatchConfig): Promise<number> {
  const tx = cfg.tx;
  const ar = tx.auto_responder;
  if (!tx.enabled || !tx.armed || tx.from_node <= 0 || !ar.enabled) return 0;
  if (!ar.respond_to_dm && !ar.respond_to_channel) return 0;
  if (!ar.triggers?.length) return 0;

  // Which recipients we react to: our own node (DM) and/or broadcast (channel).
  const recips: string[] = [];
  const params: unknown[] = [];
  if (ar.respond_to_dm) { recips.push("p.to_node_id = ?"); params.push(tx.from_node); }
  if (ar.respond_to_channel) { recips.push(`(p.to_node_id = ${BROADCAST} OR p.to_node_id IS NULL)`); }

  const rows = await query<Incoming>(
    `SELECT t.id, t.from_node_id, p.to_node_id, t.body, t.channel_id, n.long_name, n.short_name,
            (SELECT MAX(r.rx_rssi) FROM receptions r WHERE r.packet_id = t.source_packet_id) AS rssi,
            (SELECT MAX(r.rx_snr) FROM receptions r WHERE r.packet_id = t.source_packet_id) AS snr,
            (SELECT MIN(r.hop_start - r.hop_limit) FROM receptions r WHERE r.packet_id = t.source_packet_id
               AND r.hop_start IS NOT NULL AND r.hop_limit IS NOT NULL) AS hops,
            (SELECT CASE WHEN SUM(r.transport = 'rf') > 0 THEN 'rf' ELSE 'mqtt' END
               FROM receptions r WHERE r.packet_id = t.source_packet_id) AS via,
            p.source_broker_id AS source_broker
     FROM text_message t JOIN packets p ON p.id = t.source_packet_id
     LEFT JOIN nodes n ON n.node_id = t.from_node_id
     WHERE (${recips.join(" OR ")}) AND t.from_node_id <> ? AND t.observed_at >= (UTC_TIMESTAMP() - INTERVAL 5 MINUTE)
     ORDER BY t.id DESC LIMIT 50`,
    [...params, tx.from_node],
  );
  if (rows.length === 0) return 0;

  const [cnt] = await query<{ c: number }>(
    `SELECT COUNT(DISTINCT from_node_id) c FROM receptions WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`,
  );
  const activeNodes = Number(cnt?.c ?? 0);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: cfg.server.local_timezone, hour: "2-digit", minute: "2-digit" }).format(new Date());
  const keyed = new Set((await getChannelKeys()).map((k) => k.name));

  let n = 0;
  for (const m of rows) {
    const trigger = ar.triggers.find((t) => matchesPattern(m.body, t.pattern) && triggerAllowedOnChannel(t.channels, m.channel_id));
    if (!trigger) continue;
    const incomingDm = m.to_node_id === tx.from_node;
    // How to send the reply: per-trigger reply_via, defaulting to "match" (reply in-kind).
    const via = trigger.reply_via ?? "match";
    const asDm = via === "dm" || (via === "match" && incomingDm);
    // Cooldown is per sender+pattern; key it into created_by so it works for channel replies too
    // (which are broadcasts with no to_node to filter on).
    const createdBy = `${AUTO}:${trigger.pattern}:${m.from_node_id}`;
    const cd = await query<{ c: number }>(
      `SELECT COUNT(*) c FROM tx_outbox WHERE created_by = ?
         AND created_at >= (UTC_TIMESTAMP() - INTERVAL ? SECOND)`,
      [createdBy, ar.cooldown_s],
    );
    if (Number(cd[0]?.c ?? 0) > 0) continue;

    // Pick the template by how the message was HEARD, not which transport we reply on: rssi/snr are
    // properties of the reception, and an MQTT-heard packet has none, so its RF template would fill
    // {rssi}/{snr} with "?". reply_mqtt (when set) drops those tokens; fall back to reply otherwise.
    const heardOverRf = m.via === "rf";
    const reply = fillTemplate(pickReplyTemplate(trigger, heardOverRf), {
      name: m.long_name, short: m.short_name, id: formatNodeId(m.from_node_id),
      rssi: m.rssi, snr: m.snr, hops: m.hops, via: heardOverRf ? "RF" : "MQTT",
      msg: m.body, count: activeNodes, time,
    });
    // Which link(s) to reply on. `asDm` (above) decides DM vs broadcast; this decides RF vs MQTT.
    // A trigger heard only over MQTT (a node several hops away, not an RF neighbour) cannot be
    // answered by an RF broadcast, so by default we reply on the transport we heard it on: RF ->
    // the station node, MQTT -> published to the broker it arrived on (a downlink gateway near the
    // sender re-injects it onto their RF). "both" sends on each; "fixed" keeps tx.transport.
    const targets = pickReplyTargets(
      ar.reply_transport ?? "match", m.via === "rf", m.source_broker,
      tx.transport === "mqtt" ? "mqtt" : "node", tx.broker_id || null,
    );
    // DM addresses the sender; a channel reply is a broadcast (no to_node -- addressing it to the
    // sender would render as a directed/DM packet). reply_channel wins when set, so a reply lands on
    // a channel the node can actually transmit on; otherwise fall back to the incoming channel, then
    // the first keyed channel.
    const channelId = pickReplyChannel(keyed, ar.reply_channel, m.channel_id);
    for (const t of targets) {
      await enqueueTx({
        createdBy, transport: t.transport, brokerId: t.brokerId, kind: asDm ? "dm" : "text",
        channelId, toNode: asDm ? m.from_node_id : null, fromNode: tx.from_node,
        payloadText: reply, hopLimit: tx.default_hop_limit, wantAck: false,
      });
    }
    n++;
  }
  if (n) console.log(`[worker] auto-responder queued ${n} repl${n === 1 ? "y" : "ies"}`);
  return n;
}

const WELCOME = "auto-welcome";

interface Newcomer {
  node_id: number; long_name: string | null; short_name: string | null;
  hops: number | null; rssi: number | null; snr: number | null; via: string | null;
  channel: string | null;
}

/**
 * Greet first-time nodes within `within_hops` RF hops. A node is welcomed once (deduped by the
 * outbox marker `auto-welcome:<id>`); only newcomers first seen in the last hour are considered, so
 * enabling the feature does not flood-welcome the whole existing node DB. Per-run capped; the
 * outbox rate limits pace the rest.
 */
export async function runWelcome(cfg: HopWatchConfig): Promise<number> {
  const tx = cfg.tx;
  const w = tx.auto_responder?.welcome;
  if (!tx.enabled || !tx.armed || tx.from_node <= 0 || !w?.enabled) return 0;
  if (await outboxBacklog() > 12) return 0; // don't pile welcomes on top of a draining backlog

  const rows = await query<Newcomer>(
    `SELECT n.node_id, n.long_name, n.short_name, h.hops, h.rssi, h.snr, h.via,
            (SELECT pk.channel_id FROM packets pk
               WHERE pk.from_node_id = n.node_id AND pk.channel_id IS NOT NULL
               ORDER BY pk.id DESC LIMIT 1) AS channel
     FROM nodes n
     JOIN (
       SELECT from_node_id,
              MIN(hop_start - hop_limit) AS hops,
              MAX(rx_rssi) AS rssi, MAX(rx_snr) AS snr,
              CASE WHEN SUM(transport = 'rf') > 0 THEN 'rf' ELSE 'mqtt' END AS via
       FROM receptions
       WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL 60 MINUTE)
         AND hop_start IS NOT NULL AND hop_limit IS NOT NULL
         AND reception_class IN ('rf_direct','rf_relayed')
       GROUP BY from_node_id
     ) h ON h.from_node_id = n.node_id
     WHERE n.first_seen_at >= (UTC_TIMESTAMP() - INTERVAL 60 MINUTE)
       AND n.node_id <> ?
       AND h.hops IS NOT NULL AND h.hops <= ?
       AND NOT EXISTS (SELECT 1 FROM tx_outbox WHERE created_by = CONCAT(?, ':', n.node_id))
     ORDER BY n.first_seen_at DESC LIMIT 5`,
    [tx.from_node, w.within_hops, WELCOME],
  );
  if (rows.length === 0) return 0;

  const [cnt] = await query<{ c: number }>(
    `SELECT COUNT(DISTINCT from_node_id) c FROM receptions WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`,
  );
  const activeNodes = Number(cnt?.c ?? 0);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: cfg.server.local_timezone, hour: "2-digit", minute: "2-digit" }).format(new Date());
  const keyed = new Set((await getChannelKeys()).map((k) => k.name));

  let n = 0;
  for (const m of rows) {
    const asDm = w.reply_via === "dm";
    // A DM still rides a channel: prefer the one the newcomer was heard on so it reaches
    // them; a channel greeting honors the operator's configured channel first. Never null:
    // a null channel would publish unencrypted to an empty topic segment on the MQTT
    // transport and fall back to whatever the station node's primary is on the node one.
    const channelId = asDm ? pickChannel(keyed, m.channel, w.channel) : pickChannel(keyed, w.channel, m.channel);
    const text = fillTemplate(w.message, {
      name: m.long_name, short: m.short_name, id: formatNodeId(m.node_id),
      rssi: m.rssi, snr: m.snr, hops: m.hops, via: m.via === "rf" ? "RF" : "MQTT",
      msg: "", count: activeNodes, time,
    });
    await enqueueTx({
      createdBy: `${WELCOME}:${m.node_id}`, transport: tx.transport, kind: asDm ? "dm" : "text",
      channelId, toNode: asDm ? m.node_id : null, fromNode: tx.from_node,
      payloadText: text, hopLimit: tx.default_hop_limit, wantAck: false,
    });
    n++;
  }
  if (n) console.log(`[worker] welcomed ${n} new node(s)`);
  return n;
}
