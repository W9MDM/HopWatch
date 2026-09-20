import { query } from "../db/client.ts";
import type { HopWatchConfig } from "../config/schema.ts";
import { enqueueTx } from "../db/tx.ts";
import { getChannelKeys } from "../db/settings.ts";
import { pickReplyChannel } from "./autoresponder.ts";
import { formatNodeId } from "../meshtastic/types.ts";

const NUDGE = "spam-nudge";

interface Offender { node: number; c: number; sample: string; long_name: string | null; short_name: string | null; channel_id: string | null }

/**
 * Politely DM a node that repeats the same short message many times in a short window (a stuck
 * tester spamming the mesh). One DM per node, then silent for cooldown_minutes so the nudge never
 * becomes spam itself. Reply rides the armed tx_outbox (a real transmit, never a spoof), on the
 * transport the node was last heard on. Off unless tx is enabled + armed and spam_nudge.enabled.
 */
export async function runSpamNudge(cfg: HopWatchConfig): Promise<number> {
  const tx = cfg.tx;
  const sn = tx.auto_responder.spam_nudge;
  if (!tx.enabled || !tx.armed || tx.from_node <= 0 || !sn.enabled) return 0;

  // Nodes that sent the SAME normalized message >= threshold times in the window (spam signature),
  // not our own node. Grouped by node + normalized body so a chatty-but-varied node is not caught.
  const offenders = await query<Offender>(
    `SELECT t.from_node_id AS node, COUNT(*) AS c, MAX(t.body) AS sample, n.long_name, n.short_name,
            SUBSTRING_INDEX(GROUP_CONCAT(t.channel_id ORDER BY t.observed_at DESC), ',', 1) AS channel_id
     FROM text_message t LEFT JOIN nodes n ON n.node_id = t.from_node_id
     WHERE t.observed_at >= (UTC_TIMESTAMP() - INTERVAL ? MINUTE) AND t.from_node_id <> ?
     GROUP BY t.from_node_id, LOWER(TRIM(t.body))
     HAVING c >= ?
     ORDER BY c DESC LIMIT 5`,
    [sn.window_minutes, tx.from_node, sn.threshold],
  );
  if (offenders.length === 0) return 0;

  const keyed = new Set((await getChannelKeys()).map((k) => k.name));
  let n = 0;
  for (const o of offenders) {
    const createdBy = `${NUDGE}:${o.node}`;
    // One nudge per node per cooldown, so we never pile on.
    const cd = await query<{ c: number }>(
      `SELECT COUNT(*) c FROM tx_outbox WHERE created_by = ? AND created_at >= (UTC_TIMESTAMP() - INTERVAL ? MINUTE)`,
      [createdBy, sn.cooldown_minutes],
    );
    if (Number(cd[0]?.c ?? 0) > 0) continue;

    // Answer on the transport the node was last heard on (RF -> station node; else the broker it
    // arrived on, so a downlink gateway near it re-injects the DM onto its RF).
    const [route] = await query<{ via: string; broker: string | null }>(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM receptions r WHERE r.packet_id = p.id AND r.transport='rf')
                   THEN 'rf' ELSE 'mqtt' END AS via, p.source_broker_id AS broker
       FROM packets p WHERE p.from_node_id = ? ORDER BY p.first_seen_at DESC LIMIT 1`,
      [o.node],
    );
    const channelId = pickReplyChannel(keyed, "", o.channel_id);
    if (!channelId) continue; // no channel key to transmit on

    const short = o.short_name || o.long_name || formatNodeId(o.node);
    const text = sn.message
      .replace(/\{short\}/g, short)
      .replace(/\{name\}/g, o.long_name || o.short_name || formatNodeId(o.node))
      .replace(/\{count\}/g, String(o.c))
      .replace(/\{msg\}/g, (o.sample ?? "").slice(0, 40))
      .slice(0, 220);

    await enqueueTx({
      createdBy,
      transport: route?.via === "rf" ? "node" : "mqtt",
      brokerId: route?.via === "rf" ? null : (route?.broker ?? tx.broker_id ?? null),
      kind: "dm",
      channelId,
      toNode: o.node,
      fromNode: tx.from_node,
      payloadText: text,
      hopLimit: tx.max_hop_limit,
      wantAck: false,
    });
    n += 1;
  }
  return n;
}
