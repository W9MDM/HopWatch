import { query } from "../db/client.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// Recompute per-node mobility from each node's own GPS track. A node whose valid fixes span more
// than `mobile_span_deg` in latitude or longitude (over at least `mobile_min_fixes` fixes) is moving,
// not a fixed site. The /wardrive heat map excludes coverage samples heard by a mobile gateway,
// because a receiver traveling with a transmitter hears it strongly the whole way and paints a false
// coverage trail. All-time (not windowed): a node that road-tripped last month produced bad samples
// then, so its whole history stays suspect. Only 0,0 / out-of-range junk fixes are excluded from the
// span so one bad fix cannot falsely flag a stationary node. Runs on the worker's slow loop.
export async function runMobility(cfg: HopWatchConfig): Promise<number> {
  const span = cfg.wardrive.mobile_span_deg;
  const minFixes = cfg.wardrive.mobile_min_fixes;
  await query(
    `REPLACE INTO node_mobility (node_id, fixes, lat_span, lon_span, is_mobile, computed_at)
     SELECT node_id, COUNT(*) AS fixes,
            MAX(latitude) - MIN(latitude)   AS lat_span,
            MAX(longitude) - MIN(longitude) AS lon_span,
            (COUNT(*) >= ? AND (MAX(latitude) - MIN(latitude) > ? OR MAX(longitude) - MIN(longitude) > ?)) AS is_mobile,
            UTC_TIMESTAMP()
     FROM node_position_events
     WHERE latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
       AND NOT (latitude = 0 AND longitude = 0)
     GROUP BY node_id`,
    [minFixes, span, span],
  );
  const c = await query<{ c: number }>(`SELECT COUNT(*) c FROM node_mobility WHERE is_mobile = 1`);
  const n = Number(c[0]?.c ?? 0);
  console.log(`[worker] mobility: ${n} node(s) flagged mobile (span > ${span} deg)`);
  return n;
}
