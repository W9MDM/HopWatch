import { query, clampLimit } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";

export interface WxSentRow {
  alert_id: string; event: string | null; severity: string | null; area: string | null;
  /** Comma-separated configured zone codes this alert actually covered, e.g. "INC089,INC127". */
  matched_zones: string | null;
  sent_at: string;
}

/** True if this alert id was already broadcast (dedup). */
export async function alertAlreadySent(alertId: string): Promise<boolean> {
  const rows = await query<{ c: number }>(`SELECT COUNT(*) c FROM weather_alert_sent WHERE alert_id = ?`, [alertId]);
  return Number(rows[0]?.c ?? 0) > 0;
}

/** `area` is what was BROADCAST (already zone-trimmed when zones_only is on), and `matchedZones`
 * says which configured zones admitted the alert. */
export async function recordAlertSent(a: { id: string; event?: string; severity?: string; area?: string; matchedZones?: string }): Promise<void> {
  await query(
    `INSERT IGNORE INTO weather_alert_sent (alert_id, event, severity, area, matched_zones, sent_at) VALUES (?,?,?,?,?,?)`,
    [a.id.slice(0, 255), a.event?.slice(0, 80) ?? null, a.severity?.slice(0, 16) ?? null,
     a.area?.slice(0, 255) ?? null, a.matchedZones?.slice(0, 255) ?? null, toMysqlUtc(new Date())],
  );
}

/** Recent broadcast alerts, newest first (for the settings log). */
export function listAlertsSent(limit = 50): Promise<WxSentRow[]> {
  return query<WxSentRow>(
    `SELECT alert_id, event, severity, area, matched_zones, sent_at FROM weather_alert_sent ORDER BY sent_at DESC LIMIT ${clampLimit(limit, 200, 50)}`,
  );
}

export async function trimAlertsSent(days = 30): Promise<void> {
  await query(`DELETE FROM weather_alert_sent WHERE sent_at < (UTC_TIMESTAMP() - INTERVAL ? DAY)`, [days]);
}
