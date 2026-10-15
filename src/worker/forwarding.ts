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
      // A single logical message often lands as SEVERAL text_message rows: a bot (or a node) that
      // injects the same text on more than one channel, plus the copies that arrive over each MQTT
      // broker we ingest, each carry a DIFFERENT mesh_packet_id, so they are genuinely distinct
      // packets and the ingest dedup cannot (and should not) collapse them. Forwarding them all
      // spams the Discord/Apprise target with identical posts. So we forward each unique
      // (from_node_id, body) at most once within a short window: `dup` flags any row that repeats an
      // earlier one, and we skip it while still advancing the cursor past it.
      const rows = await query<{ id: number; from_node_id: number; channel_id: string | null; body: string; name: string | null; dup: number }>(
        `SELECT t.id, t.from_node_id, t.channel_id, t.body, n.long_name AS name,
                EXISTS(
                  SELECT 1 FROM text_message d
                  WHERE d.from_node_id = t.from_node_id AND d.body = t.body
                    AND d.id < t.id AND d.observed_at >= t.observed_at - INTERVAL 15 MINUTE
                ) AS dup
         FROM text_message t LEFT JOIN nodes n ON n.node_id=t.from_node_id
         WHERE t.id > ? AND t.to_node_id IS NULL${chSql} ORDER BY t.id ASC LIMIT 100`,
        params,
      );
      for (const m of rows) {
        lastTextId = Math.max(lastTextId, m.id); // advance past every row seen, duplicates included
        if (m.dup) continue;                     // a cross-channel / cross-broker repeat of the same text
        const who = m.name ?? formatNodeId(m.from_node_id);
        await notify(rule.targets, { title: `Mesh${m.channel_id ? ` [${m.channel_id}]` : ""}`, body: `${who}: ${m.body}` });
        sent++;
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
