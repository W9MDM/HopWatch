import { query } from "../db/client.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// Geo-fence: hide nodes whose known position falls outside the configured bounding box. A distant
// region bridged in over MQTT (another broker's traffic federated into yours) otherwise floods the
// local maps, coverage, and graph. We mark those nodes position_ignored, which every map/coverage/
// graph query already excludes, so they vanish from those views without being deleted (a node wrongly
// fenced can be un-ignored in /admin). We only SET the flag, never clear it, so this never undoes an
// admin's manual position ignore. Runs on the worker's slow loop.
export async function runGeoFence(cfg: HopWatchConfig): Promise<number> {
  const g = cfg.ingest.geo_fence;
  if (!g?.enabled) return 0;
  const lo = Math.min(g.min_lat, g.max_lat), hi = Math.max(g.min_lat, g.max_lat);
  const wlo = Math.min(g.min_lon, g.max_lon), whi = Math.max(g.min_lon, g.max_lon);
  // Guard against an unset/degenerate box (all zeros, or out of range) so a misconfig cannot hide the
  // whole fleet.
  if (![lo, hi, wlo, whi].every(Number.isFinite) || (lo === hi && wlo === whi) ||
      lo < -90 || hi > 90 || wlo < -180 || whi > 180) return 0;

  const where =
    `(n.position_ignored = 0 OR n.position_ignored IS NULL)
       AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL
       AND NOT (p.latitude BETWEEN ? AND ? AND p.longitude BETWEEN ? AND ?)`;
  const params = [lo, hi, wlo, whi];
  const cnt = await query<{ c: number }>(
    `SELECT COUNT(*) c FROM nodes n JOIN node_positions p ON p.node_id = n.node_id WHERE ${where}`, params);
  const n = Number(cnt[0]?.c ?? 0);
  if (n > 0) {
    await query(`UPDATE nodes n JOIN node_positions p ON p.node_id = n.node_id SET n.position_ignored = 1 WHERE ${where}`, params);
    console.log(`[worker] geo-fence hid ${n} out-of-area node(s)`);
  }
  return n;
}
