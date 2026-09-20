import { query } from "../db/client.ts";
import { toMysqlUtc, floorHourUtc } from "../lib/time.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// Mesh health score: a 0-100 number from configurable weighted inputs, each
// normalized to 0..1 where higher is healthier. The breakdown is stored alongside
// the score so the UI can show why (spec: show the breakdown, not just the number).
//
// A sub-score with no data is DROPPED, not defaulted. Coercing a missing input to a number was
// silently generous in both directions: `AVG(value)` over an empty set is NULL, `Number(null ?? 0)`
// is 0, and utilization is `1 - 0/50` = a perfect 1.0. A mesh whose gateways publish only the JSON
// topic, or whose nodes have device telemetry off, was therefore awarded that weight in full; a
// brand-new empty install scored 65/100. Renormalizing over the sub-scores that actually have
// evidence means "unknown" no longer reads as "perfect", and the stored breakdown says which inputs
// were skipped so the UI can explain the number.
const UTIL_CAP = 50; // percent channel utilization considered "fully saturated"
const COVERAGE_TARGET = 3; // gateways per node considered good breadth
const ANOMALY_CAP = 5; // unresolved spoof flags considered "bad"

export async function computeHealthScore(cfg: HopWatchConfig): Promise<number | null> {
  const [util] = await query<{ v: number | null }>(
    `SELECT AVG(value) v FROM node_telemetry WHERE metric='chan_util' AND observed_at >= (UTC_TIMESTAMP() - INTERVAL 3 HOUR)`,
  );
  const [deliv] = await query<{ decoded: number; total: number }>(
    `SELECT SUM(decode_status='decoded') decoded, COUNT(*) total FROM packets
     WHERE first_seen_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`,
  );
  const [cov] = await query<{ v: number | null }>(
    `SELECT AVG(unique_gateways) v FROM node_rollup_hour WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`,
  );
  const [now] = await query<{ v: number | null }>(
    `SELECT MAX(active_nodes) v FROM mesh_rollup_hour WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`,
  );
  const [prev] = await query<{ v: number | null }>(
    `SELECT MAX(active_nodes) v FROM mesh_rollup_hour
     WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL 48 HOUR) AND bucket_start < (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`,
  );
  const [flags] = await query<{ c: number }>(
    `SELECT COUNT(*) c FROM node_flags WHERE flag_type='spoof_pubkey' AND resolved_at IS NULL`,
  );

  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // null = no evidence for this factor, so it is excluded from the weighted average entirely.
  const utilAvg = num(util?.v);
  const covAvg = num(cov?.v);
  const nowActive = num(now?.v);
  const prevActive = num(prev?.v);
  const inputs: Record<string, number | null> = {
    utilization: utilAvg === null ? null : clamp01(1 - utilAvg / UTIL_CAP),
    delivery_ratio: deliv && Number(deliv.total) > 0 ? clamp01(Number(deliv.decoded) / Number(deliv.total)) : null,
    gateway_coverage: covAvg === null ? null : clamp01(covAvg / COVERAGE_TARGET),
    // Needs BOTH windows: without yesterday there is no trend, and dividing by max(1, 0) made a
    // first-day install look like a collapse or a boom depending on which side was missing.
    active_node_trend: nowActive === null || prevActive === null || prevActive <= 0
      ? null
      : clamp01(nowActive / prevActive),
    // Zero unresolved flags is a real measurement, not missing data.
    anomalies: clamp01(1 - Number(flags?.c ?? 0) / ANOMALY_CAP),
  };

  const weights = cfg.analytics.health_score.weights;
  const skipped: string[] = [];
  let wsum = 0;
  let acc = 0;
  for (const [k, w] of Object.entries(weights)) {
    const wn = Number(w);
    if (!(k in inputs) || !Number.isFinite(wn)) continue;
    const v = inputs[k];
    if (v === null || v === undefined) { skipped.push(k); continue; }
    wsum += wn;
    acc += wn * v;
  }
  // Every factor unknown: report no score rather than inventing one. /health renders a null score
  // as "not enough data", which is the honest answer on a fresh install.
  if (wsum === 0) return null;
  const score = Math.round((acc / wsum) * 100);

  await query(
    `INSERT INTO health_snapshot (id, score, breakdown, computed_at) VALUES (1,?,?,?)
     ON DUPLICATE KEY UPDATE score=VALUES(score), breakdown=VALUES(breakdown), computed_at=VALUES(computed_at)`,
    [score, JSON.stringify({ inputs, weights, score, skipped }), toMysqlUtc(new Date())],
  );
  // The LAST COMPLETE hour, not the current one. runHourlyRollups only folds hours strictly before
  // floorHour(now), so the newest mesh_rollup_hour bucket that can exist is floorHour(now) - 1h:
  // this UPDATE matched zero rows on every run, and the fold's own upsert does not touch
  // health_score, so the column was permanently NULL and the per-hour health history it exists for
  // could never be charted.
  await query(
    `UPDATE mesh_rollup_hour SET health_score=? WHERE bucket_start=?`,
    [score, toMysqlUtc(new Date(floorHourUtc(new Date()).getTime() - 3_600_000))],
  );
  return score;
}
