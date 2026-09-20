import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// Phase 3 spam score: reception rate (receptions/hour) over the configured window,
// from node_rollup_hour. A fuller score (duplicate ratio, low-value ports) is a
// later refinement; the weights already live in config.analytics.spam_score.
export async function updateSpamScores(cfg: HopWatchConfig): Promise<void> {
  const hours = cfg.analytics.spam_score.window_hours;
  await query(
    `UPDATE nodes n
     LEFT JOIN (
       SELECT node_id, SUM(reception_count) / ? AS rate
       FROM node_rollup_hour
       WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
       GROUP BY node_id
     ) x ON x.node_id = n.node_id
     SET n.spam_score = x.rate`,
    [hours, hours],
  );
}

// Apply the config mute seed once (display-only; never touches the mesh).
export async function applyConfigMuteSeed(cfg: HopWatchConfig): Promise<void> {
  const seed = cfg.analytics.mute.seed;
  for (const nodeId of seed) {
    await query(
      `INSERT INTO mute_list (node_id, reason, added_by, added_at, source) VALUES (?, 'config seed', 'config', ?, 'config')
       ON DUPLICATE KEY UPDATE source='config'`,
      [nodeId, toMysqlUtc(new Date())],
    );
    await query(`UPDATE nodes SET mute_hidden=1 WHERE node_id=?`, [nodeId]);
  }
}
