import { query } from "../db/client.ts";
import { toMysqlUtc, floorHourUtc } from "../lib/time.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// Tropo/ducting detector. Maintains a rolling per-(gateway,node) RSSI baseline from
// the hourly rollups, then logs a propagation_event when a link improves beyond a
// configurable dB threshold, or when a far node is first heard direct (spec: RF/prop).
const MIN_SAMPLES = 20;

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3_600_000);
}

export async function updateBaselines(cfg: HopWatchConfig): Promise<void> {
  const win = cfg.rf.propagation.baseline_window_hours;
  await query(
    `INSERT INTO rf_link_baseline (gateway_id, node_id, baseline_rssi, baseline_snr, sample_count, window_hours, updated_at)
     SELECT gateway_id, node_id,
            AVG(rssi_direct_p50),
            AVG(snr_direct_p50),
            SUM(direct_count), ?, ?
     FROM reception_rollup_hour
     WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND rssi_direct_p50 IS NOT NULL
     GROUP BY gateway_id, node_id
     ON DUPLICATE KEY UPDATE
       baseline_rssi=VALUES(baseline_rssi), baseline_snr=VALUES(baseline_snr),
       sample_count=VALUES(sample_count), window_hours=VALUES(window_hours), updated_at=VALUES(updated_at)`,
    [win, toMysqlUtc(new Date()), win],
  );
}

export async function detectPropagation(cfg: HopWatchConfig): Promise<number> {
  const prop = cfg.rf.propagation;
  if (!prop.enabled) return 0;
  const threshold = prop.improvement_threshold_db;
  const dxKm = prop.dx_distance_threshold_km;
  const now = new Date();
  const lastHour = toMysqlUtc(addHours(floorHourUtc(now), -1)); // last complete hour

  // Enhancement: the last complete hour beats the baseline by >= threshold dB.
  const enh = await query<{ n: number }>(
    `INSERT INTO propagation_events
       (gateway_id, node_id, detected_at, event_type, baseline_rssi, observed_rssi, delta_db)
     SELECT c.gateway_id, c.node_id, ?, 'enhancement', b.baseline_rssi, c.cur_rssi, (c.cur_rssi - b.baseline_rssi)
     FROM (SELECT gateway_id, node_id, rssi_direct_sum/NULLIF(rssi_direct_count,0) AS cur_rssi
           FROM reception_rollup_hour WHERE bucket_start=?) c
     JOIN rf_link_baseline b ON b.gateway_id=c.gateway_id AND b.node_id=c.node_id
     WHERE b.sample_count>=? AND b.baseline_rssi IS NOT NULL AND c.cur_rssi IS NOT NULL
       AND (c.cur_rssi - b.baseline_rssi) >= ?
       AND NOT EXISTS (SELECT 1 FROM propagation_events p
                       WHERE p.gateway_id=c.gateway_id AND p.node_id=c.node_id AND p.event_type='enhancement'
                         AND p.detected_at >= (UTC_TIMESTAMP() - INTERVAL 3 HOUR))`,
    [toMysqlUtc(now), lastHour, MIN_SAMPLES, threshold],
  ).then(() => query<{ n: number }>(`SELECT ROW_COUNT() n`));

  // DX: a far node heard direct for the first time in the last hour.
  await query(
    `INSERT INTO propagation_events
       (gateway_id, node_id, detected_at, event_type, observed_rssi, delta_db, distance_km)
     SELECT s.gateway_id, s.node_id, ?, 'dx_direct', s.last_direct_rssi, 0, s.distance_km
     FROM (
       SELECT l.gateway_id, l.node_id, l.last_direct_rssi,
              6371*ACOS(LEAST(1, COS(RADIANS(gp.latitude))*COS(RADIANS(np.latitude))*
                COS(RADIANS(np.longitude)-RADIANS(gp.longitude))+SIN(RADIANS(gp.latitude))*SIN(RADIANS(np.latitude)))) AS distance_km
       FROM gateway_node_link l
       JOIN node_positions gp ON gp.node_id=l.gateway_id
       JOIN node_positions np ON np.node_id=l.node_id
       WHERE l.direct_count>0 AND l.gateway_id<>l.node_id
         AND l.first_direct_at >= (UTC_TIMESTAMP() - INTERVAL 1 HOUR)
         AND gp.latitude IS NOT NULL AND np.latitude IS NOT NULL
     ) s
     WHERE s.distance_km >= ?
       AND NOT EXISTS (SELECT 1 FROM propagation_events p
                       WHERE p.gateway_id=s.gateway_id AND p.node_id=s.node_id AND p.event_type='dx_direct'
                         AND p.detected_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY))`,
    [toMysqlUtc(now), dxKm],
  );

  return Number(enh[0]?.n ?? 0);
}
