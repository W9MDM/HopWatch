import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { listForwardRules } from "../db/settings.ts";
import { notify } from "./apprise.ts";

// Forward new mesh activity (text messages, new nodes) to Apprise targets per rule,
// filtered by channel. Cursor state per rule so nothing is sent twice; a fresh rule
// starts from "now" so it never dumps history.
export async function runForwarding(): Promise<number> {
  const rules = await listForwardRules(true);
  let sent = 0;
  for (const rule of rules) {
    if (rule.targets.length === 0) continue;
    const st = (await query<{ last_text_id: number; last_node_seen: string | null }>(
      `SELECT last_text_id, last_node_seen FROM forward_state WHERE rule_id=?`,
      [rule.id],
    ))[0];

    if (!st) {
      const [mx] = await query<{ m: number | null }>(`SELECT MAX(id) m FROM text_message`);
      await query(
        `INSERT INTO forward_state (rule_id, last_text_id, last_node_seen, updated_at) VALUES (?,?,?,?)`,
        [rule.id, Number(mx?.m ?? 0), toMysqlUtc(new Date()), toMysqlUtc(new Date())],
      );
      continue; // only forward activity created after the rule exists
    }

    let lastTextId = Number(st.last_text_id);
    let lastNode = st.last_node_seen;

    // Channel broadcasts only (to_node_id IS NULL): overheard directed messages (DMs) are
    // someone's private conversation and must not be pushed to external targets.
    if (rule.events.includes("text")) {
      const params: unknown[] = [lastTextId];
      let chSql = "";
      if (rule.channels.length) {
        chSql = ` AND t.channel_id IN (${rule.channels.map(() => "?").join(",")})`;
        params.push(...rule.channels);
      }
      const rows = await query<{ id: number; from_node_id: number; channel_id: string | null; body: string; name: string | null }>(
        `SELECT t.id, t.from_node_id, t.channel_id, t.body, n.long_name AS name
         FROM text_message t LEFT JOIN nodes n ON n.node_id=t.from_node_id
         WHERE t.id > ? AND t.to_node_id IS NULL${chSql} ORDER BY t.id ASC LIMIT 100`,
        params,
      );
      for (const m of rows) {
        const who = m.name ?? formatNodeId(m.from_node_id);
        await notify(rule.targets, { title: `Mesh${m.channel_id ? ` [${m.channel_id}]` : ""}`, body: `${who}: ${m.body}` });
        sent++;
        lastTextId = Math.max(lastTextId, m.id);
      }
    }

    if (rule.events.includes("new_node")) {
      const since = lastNode ?? toMysqlUtc(new Date(Date.now() - 3600000));
      const rows = await query<{ node_id: number; long_name: string | null; first_seen_at: string }>(
        `SELECT node_id, long_name, first_seen_at FROM nodes WHERE first_seen_at > ? ORDER BY first_seen_at ASC LIMIT 50`,
        [since],
      );
      for (const n of rows) {
        await notify(rule.targets, { title: "New node", body: `${n.long_name ?? formatNodeId(n.node_id)} first heard` });
        sent++;
        lastNode = n.first_seen_at;
      }
    }

    await query(
      `UPDATE forward_state SET last_text_id=?, last_node_seen=?, updated_at=? WHERE rule_id=?`,
      [lastTextId, lastNode, toMysqlUtc(new Date()), rule.id],
    );
  }
  return sent;
}
