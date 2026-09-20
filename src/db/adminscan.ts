import { query } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";

// Remote-admin scanner store. Unlike a live "recently scanned" view, this is a PERSISTENT record:
// once a node answers an admin DeviceMetadata request it stays on the list (with first/last-seen
// and a success count) until an admin removes it. Rows with last_ok_at set are administrable;
// rows with only last_scan_at were probed but did not answer.

export interface RemoteAdminRow {
  node_id: number; node_hex: string; long_name: string | null; short_name: string | null;
  first_ok_at: string | null; last_ok_at: string | null; last_scan_at: string | null;
  ok_count: number; firmware_version: string | null; hw_model: string | null; role: string | null;
}

/** Record a successful admin response (the node is administrable). Sets first_ok_at once. */
export async function recordAdminOk(nodeId: number, meta: { firmware?: string; hwModel?: string; role?: string }): Promise<void> {
  const now = toMysqlUtc(new Date());
  await query(
    `INSERT INTO remote_admin (node_id, first_ok_at, last_ok_at, last_scan_at, ok_count, firmware_version, hw_model, role)
       VALUES (?,?,?,?,1,?,?,?)
     ON DUPLICATE KEY UPDATE
       first_ok_at = COALESCE(first_ok_at, VALUES(first_ok_at)),
       last_ok_at = VALUES(last_ok_at), last_scan_at = VALUES(last_scan_at),
       ok_count = ok_count + 1,
       firmware_version = COALESCE(VALUES(firmware_version), firmware_version),
       hw_model = COALESCE(VALUES(hw_model), hw_model),
       role = COALESCE(VALUES(role), role)`,
    [nodeId >>> 0, now, now, now, meta.firmware ?? null, meta.hwModel ?? null, meta.role ?? null],
  );
}

/** Record that a node was probed (no answer yet), so we do not re-probe it every tick. */
export async function markScanned(nodeId: number): Promise<void> {
  const now = toMysqlUtc(new Date());
  await query(
    `INSERT INTO remote_admin (node_id, last_scan_at, ok_count) VALUES (?,?,0)
     ON DUPLICATE KEY UPDATE last_scan_at = VALUES(last_scan_at)`,
    [nodeId >>> 0, now],
  );
}

/** Full record, administrable nodes first, then most-recently-scanned. */
export function listRemoteAdmin(): Promise<RemoteAdminRow[]> {
  return query<RemoteAdminRow>(
    `SELECT ra.node_id, LOWER(CONCAT('!', LPAD(HEX(ra.node_id), 8, '0'))) AS node_hex,
            n.long_name, n.short_name, ra.first_ok_at, ra.last_ok_at, ra.last_scan_at,
            ra.ok_count, ra.firmware_version, ra.hw_model, ra.role
     FROM remote_admin ra
     LEFT JOIN nodes n ON n.node_id = ra.node_id
     ORDER BY (ra.last_ok_at IS NOT NULL) DESC, ra.last_ok_at DESC, ra.last_scan_at DESC
     LIMIT 1000`,
  );
}

/** Forget one recorded node (admin cleanup). */
export async function forgetRemoteAdmin(nodeId: number): Promise<void> {
  await query(`DELETE FROM remote_admin WHERE node_id = ?`, [nodeId >>> 0]);
}

/**
 * Active nodes due for a probe. Nodes that have NOT answered are retried every staleHours (to catch
 * newly-authorized ones). Nodes that already answered (administrable) are NOT re-probed unless
 * reconfirmHours > 0, and then only after that long (to refresh firmware / catch revoked access).
 */
export function scanCandidates(limit: number, staleHours: number, activeHours: number, reconfirmHours: number): Promise<{ node_id: number }[]> {
  return query<{ node_id: number }>(
    `SELECT DISTINCT r.from_node_id AS node_id
     FROM receptions r
     LEFT JOIN remote_admin ra ON ra.node_id = r.from_node_id
     WHERE r.rx_time >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
       AND (
         ra.node_id IS NULL
         OR (ra.last_ok_at IS NULL AND (ra.last_scan_at IS NULL OR ra.last_scan_at < (UTC_TIMESTAMP() - INTERVAL ? HOUR)))
         OR (ra.last_ok_at IS NOT NULL AND ? > 0 AND ra.last_ok_at < (UTC_TIMESTAMP() - INTERVAL ? HOUR))
       )
     ORDER BY (ra.node_id IS NULL) DESC, ra.last_scan_at IS NULL DESC, r.from_node_id
     LIMIT ?`,
    [activeHours, staleHours, reconfirmHours, reconfirmHours, Math.max(1, Math.min(limit, 50))],
  );
}
