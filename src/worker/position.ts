import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import type { HopWatchConfig } from "../config/schema.ts";
import { buildPairEvidence, estimatePosition, type RawReception } from "../lib/position.ts";

// Position estimation job. Estimates the location of nodes that never transmit a
// position, from the zero-hop receptions of gateways whose positions are known. Runs
// on the worker timer only, never in a request handler. Recompute is bounded by
// recompute_interval_minutes and only touches nodes with new zero-hop evidence.
//
// An estimate is written to its own table (position_estimate). It is never merged into
// or allowed to shadow a real node_positions row: a node that has ever transmitted a
// real position is excluded here, so a real fix always supersedes the estimate.

const MAX_RECEPTIONS_PER_NODE = 5000; // cap raw rows pulled per node per run

function toDate(mysqlUtc: string): number {
  return new Date(mysqlUtc.replace(" ", "T") + "Z").getTime();
}

export async function estimatePositions(cfg: HopWatchConfig): Promise<number> {
  const pe = cfg.position_estimation;
  if (!pe?.enabled) return 0;

  // Honor the configured cadence even though the worker slow loop ticks faster: only
  // recompute once per recompute_interval_minutes (survives restarts via the table).
  const lastRows = await query<{ last: string | null }>(`SELECT MAX(computed_at) AS last FROM position_estimate`);
  const last = lastRows[0]?.last ?? null;
  if (last && (Date.now() - toDate(last)) / 60_000 < pe.recompute_interval_minutes) return 0;

  // Candidate nodes: heard direct (zero-hop) by a positioned gateway in the window, and
  // with no real position of their own. Track each node's latest zero-hop rx_time.
  const candidates = await query<{ node_id: number; last_rx: string }>(
    `SELECT r.from_node_id AS node_id, MAX(r.rx_time) AS last_rx
     FROM receptions r
     JOIN node_positions gp ON gp.node_id = r.gateway_id AND gp.latitude IS NOT NULL AND gp.longitude IS NOT NULL
     LEFT JOIN node_positions np ON np.node_id = r.from_node_id AND np.latitude IS NOT NULL AND np.longitude IS NOT NULL
     WHERE r.reception_class = 'rf_direct' AND r.rx_time >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
       AND np.node_id IS NULL
     GROUP BY r.from_node_id`,
    [pe.window_days],
  );
  if (candidates.length === 0) return 0;

  // Only recompute a node when it has zero-hop evidence newer than its last estimate.
  const lastEst = new Map<number, number>();
  const er = await query<{ node_id: number; c: string }>(
    `SELECT node_id, MAX(computed_at) AS c FROM position_estimate GROUP BY node_id`,
  );
  for (const row of er) lastEst.set(row.node_id, toDate(row.c));
  const todo = candidates.filter((c) => {
    const le = lastEst.get(c.node_id);
    return le === undefined || toDate(c.last_rx) > le;
  });

  const params = {
    pathLossExponent: pe.path_loss_exponent,
    referenceLossDb1km: pe.reference_loss_db_1km,
    mobileVarianceThresholdDb: pe.mobile_variance_threshold_db,
  };

  let n = 0;
  for (const c of todo) {
    // Fetch direct AND relayed receptions on purpose: the pure evidence builder rejects
    // relayed rows, so relay exclusion is exercised on real data, not just in tests.
    const recs = await query<{
      gateway_id: number; rx_rssi: number | null; hop_start: number | null; hop_limit: number | null;
      reception_class: string; latitude: number; longitude: number;
    }>(
      `SELECT r.gateway_id, r.rx_rssi, r.hop_start, r.hop_limit, r.reception_class,
              gp.latitude, gp.longitude
       FROM receptions r
       JOIN node_positions gp ON gp.node_id = r.gateway_id AND gp.latitude IS NOT NULL AND gp.longitude IS NOT NULL
       WHERE r.from_node_id = ? AND r.rx_time >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
         AND r.reception_class IN ('rf_direct','rf_direct_low_conf','rf_relayed')
       ORDER BY r.rx_time DESC
       LIMIT ${MAX_RECEPTIONS_PER_NODE}`,
      [c.node_id, pe.window_days],
    );
    const raw: RawReception[] = recs.map((x) => ({
      gatewayId: x.gateway_id, lat: x.latitude, lon: x.longitude,
      rssi: x.rx_rssi, hopStart: x.hop_start, hopLimit: x.hop_limit, receptionClass: x.reception_class,
    }));
    const pairs = buildPairEvidence(raw, pe.min_receptions_per_pair);
    const est = estimatePosition(pairs, params);
    if (!est) continue;

    await query(
      `INSERT INTO position_estimate
         (node_id, method_tier, latitude, longitude, confidence_radius_m, receiver_count, window_days, possibly_mobile, computed_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [c.node_id, est.tier, est.lat, est.lon, est.radiusM, est.receiverCount, pe.window_days, est.possiblyMobile ? 1 : 0, toMysqlUtc(new Date())],
    );
    n++;
  }
  if (n) console.log(`[worker] position-estimation wrote ${n} estimate(s)`);
  return n;
}
