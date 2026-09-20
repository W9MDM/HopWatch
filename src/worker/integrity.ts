import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { formatNodeId } from "../meshtastic/types.ts";

// Relay identification + NodeInfo flapping detection (spec: node identity/integrity).

// The relay_node header carries only the LAST BYTE of the relayer's node id, so a
// byte maps to a set of candidate nodes. We record the inventory, and only set
// is_relay / flag a role violation when the candidate is UNAMBIGUOUS (one match),
// to avoid false positives at scale.
// evidence_count is the TRAILING 24h observation count, REPLACED on every run.
//
// It used to be accumulated ("evidence_count = evidence_count + VALUES(evidence_count)") while the
// SELECT below measured a sliding 24h window, and this job runs every 30 minutes: the same window
// was added 48 times a day, so a relay byte genuinely seen 100 times/day reached ~4,800/day and
// ~1.75M/year. The column is displayed verbatim on /backbone and is the ORDER BY for the relay
// inventory, so the ranking was by lifetime-integral-times-48 rather than by observations, and a
// byte that was busy last year permanently outranked one that is busy today. It now means exactly
// what the query measures.
export async function updateRelays(): Promise<void> {
  const bytes = await query<{ b: number; c: number; last: string }>(
    `SELECT relay_node AS b, COUNT(*) AS c, MAX(rx_time) AS last
     FROM receptions
     WHERE relay_node IS NOT NULL AND relay_node <> 0 AND rx_time >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)
     GROUP BY relay_node`,
  );
  for (const row of bytes) {
    const candidates = await query<{ node_id: number; role: string | null }>(
      `SELECT node_id, role FROM nodes WHERE (node_id & 0xFF) = ?`,
      [row.b],
    );
    const violation = candidates.length === 1 && (candidates[0]!.role ?? "").toUpperCase().includes("CLIENT_MUTE");
    await query(
      `INSERT INTO relay_nodes (relay_node_byte, candidate_nodes, first_seen_at, last_seen_at, evidence_count, role_violation)
         VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE candidate_nodes=VALUES(candidate_nodes), last_seen_at=VALUES(last_seen_at),
         evidence_count=VALUES(evidence_count), role_violation=VALUES(role_violation)`,
      [row.b, JSON.stringify(candidates.map((c) => c.node_id)), toMysqlUtc(new Date(row.last + "Z")), toMysqlUtc(new Date(row.last + "Z")), row.c, violation ? 1 : 0],
    );
    if (candidates.length === 1) {
      await query(`UPDATE nodes SET is_relay=1 WHERE node_id=?`, [candidates[0]!.node_id]);
      if (violation) {
        await query(
          `INSERT INTO node_flags (node_id, flag_type, severity, message, created_at, evidence)
           SELECT ?, 'role_violation', 'warn', 'CLIENT_MUTE node observed relaying', ?, JSON_OBJECT('relay_byte', ?)
           FROM DUAL WHERE NOT EXISTS (
             SELECT 1 FROM node_flags WHERE node_id=? AND flag_type='role_violation' AND resolved_at IS NULL)`,
          [candidates[0]!.node_id, toMysqlUtc(new Date()), row.b, candidates[0]!.node_id],
        );
      }
    }
  }
}

// Flapping: a NodeInfo field that changed >=3 times in 24h among <=2 distinct values
// looks like two identities fighting over one node id. Raise one identity_flap flag.
export async function detectFlapping(): Promise<number> {
  const rows = await query<{ node_id: number; event_type: string; c: number; d: number }>(
    `SELECT node_id, event_type, COUNT(*) c, COUNT(DISTINCT new_value) d
     FROM node_identity_events
     WHERE observed_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)
     GROUP BY node_id, event_type
     HAVING c >= 3 AND d <= 2`,
  );
  let flagged = 0;
  for (const r of rows) {
    const res = await query<{ affected: number }>(
      `INSERT INTO node_flags (node_id, flag_type, severity, message, created_at, evidence)
       SELECT ?, 'identity_flap', 'warn', ?, ?, JSON_OBJECT('field', ?, 'changes', ?)
       FROM DUAL WHERE NOT EXISTS (
         SELECT 1 FROM node_flags WHERE node_id=? AND flag_type='identity_flap' AND resolved_at IS NULL)`,
      [r.node_id, `${r.event_type} flapping between ${r.d} values (${r.c} changes/24h)`, toMysqlUtc(new Date()), r.event_type, r.c, r.node_id],
    ).then(() => query<{ n: number }>(`SELECT ROW_COUNT() n`)).then((x) => [{ affected: Number(x[0]?.n ?? 0) }]);
    if (res[0]!.affected > 0) {
      flagged++;
      await query(`UPDATE nodes SET anomaly_flag_count = anomaly_flag_count + 1 WHERE node_id=?`, [r.node_id]);
    }
  }
  return flagged;
}

/**
 * Raise one flag if an identical open one does not already exist. Returns whether it was inserted.
 * Keeps the "flag once until resolved" behaviour the flapping check established, so a recurring
 * condition does not produce a row per tick.
 */
async function raiseFlag(
  nodeId: number, type: string, severity: string, message: string, evidence: Record<string, unknown>,
): Promise<boolean> {
  const existing = await query<{ c: number }>(
    `SELECT COUNT(*) c FROM node_flags WHERE node_id=? AND flag_type=? AND resolved_at IS NULL`,
    [nodeId, type],
  );
  if (Number(existing[0]?.c ?? 0) > 0) return false;
  await query(
    `INSERT INTO node_flags (node_id, flag_type, severity, message, created_at, evidence)
     VALUES (?,?,?,?,?,?)`,
    [nodeId, type, severity, message.slice(0, 255), toMysqlUtc(new Date()), JSON.stringify(evidence)],
  );
  await query(`UPDATE nodes SET anomaly_flag_count = anomaly_flag_count + 1 WHERE node_id=?`, [nodeId]);
  return true;
}

/**
 * Uniqueness and consistency conflicts across `nodes`. Complements the per-node checks above, which
 * only ever look at one node's history: these are the conflicts that exist only BETWEEN nodes, plus
 * the inverse of the existing role check.
 */
export async function detectConflicts(): Promise<number> {
  let flagged = 0;
  const now = toMysqlUtc(new Date());

  // (a) Two different node ids presenting the SAME public key. The converse of the spoof_pubkey
  //     check, and the signature of a cloned device or a restored NodeDB backup. It breaks PKI DMs
  //     for everyone who cached either identity, and nothing looked for it.
  const dupKeys = await query<{ public_key_hex: string; ids: string; c: number }>(
    `SELECT public_key_hex, GROUP_CONCAT(node_id) ids, COUNT(*) c
     FROM nodes WHERE public_key_hex IS NOT NULL AND public_key_hex <> ''
     GROUP BY public_key_hex HAVING c > 1 LIMIT 200`,
  );
  for (const k of dupKeys) {
    const ids = k.ids.split(",").map(Number).filter(Boolean);
    for (const id of ids) {
      const others = ids.filter((x) => x !== id);
      if (await raiseFlag(id, "duplicate_pubkey", "critical",
        `public key shared with ${others.length} other node(s): ${others.map((x) => formatNodeId(x)).join(", ")}`,
        { public_key_hex: k.public_key_hex, node_ids: ids })) flagged++;
    }
  }

  // (b) Two nodes active in the window claiming the same short name. Not a protocol violation, but
  //     the routine cause of operator confusion, and invisible until someone spots it by hand.
  const dupShort = await query<{ short_name: string; ids: string; c: number }>(
    `SELECT short_name, GROUP_CONCAT(node_id) ids, COUNT(*) c
     FROM nodes
     WHERE short_name IS NOT NULL AND short_name <> ''
       AND last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)
     GROUP BY short_name HAVING c > 1 LIMIT 200`,
  );
  for (const k of dupShort) {
    const ids = k.ids.split(",").map(Number).filter(Boolean);
    for (const id of ids) {
      const others = ids.filter((x) => x !== id);
      if (await raiseFlag(id, "duplicate_short_name", "info",
        `short name "${k.short_name}" also claimed by ${others.map((x) => formatNodeId(x)).join(", ")}`,
        { short_name: k.short_name, node_ids: ids })) flagged++;
    }
  }

  // (c) A router that is not routing: role claims ROUTER or REPEATER, the node is active, and its
  //     low byte has never appeared as a relay_node. The existing role_violation check is the
  //     opposite case (a CLIENT_MUTE that IS relaying), so this side went unseen. Only flagged when
  //     the byte is unambiguous, matching the caution the relay inventory already applies: a byte
  //     shared with another node cannot prove this node did not relay.
  const idleRouters = await query<{ node_id: number; role: string }>(
    `SELECT n.node_id, n.role FROM nodes n
      WHERE n.role IN ('ROUTER','REPEATER','ROUTER_LATE')
        AND n.last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)
        AND (SELECT COUNT(*) FROM nodes o WHERE (o.node_id & 0xFF) = (n.node_id & 0xFF)) = 1
        AND NOT EXISTS (
          SELECT 1 FROM relay_nodes r
           WHERE r.relay_node_byte = (n.node_id & 0xFF)
             AND r.last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR))
      LIMIT 200`,
  );
  for (const r of idleRouters) {
    if (await raiseFlag(r.node_id, "router_not_relaying", "warn",
      `role is ${r.role} but no relayed reception carried its byte in 24h`,
      { role: r.role, checked_at: now })) flagged++;
  }

  return flagged;
}
