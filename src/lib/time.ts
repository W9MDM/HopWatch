// UTC-only time helpers. Storage is always UTC (spec: no naive datetime handling).
// MySQL DATETIME(3) has no timezone, so we serialize UTC as 'YYYY-MM-DD HH:MM:SS.mmm'.

/** Format a Date as a MySQL DATETIME(3) literal in UTC. */
export function toMysqlUtc(d: Date): string {
  const iso = d.toISOString(); // 2026-07-11T13:45:12.345Z
  return iso.slice(0, 10) + " " + iso.slice(11, 23);
}

/** Format a Date as a MySQL DATE literal in UTC. */
export function toMysqlDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Floor a Date to the start of its UTC hour. */
export function floorHourUtc(d: Date): Date {
  const t = new Date(d);
  t.setUTCMinutes(0, 0, 0);
  return t;
}

/** Floor a Date to the start of its UTC day. */
export function floorDayUtc(d: Date): Date {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  return t;
}

/** Coarse dedup bucket: floor(epochSeconds / windowSeconds). */
export function dedupBucket(rxTime: Date, windowSeconds: number): number {
  return Math.floor(rxTime.getTime() / 1000 / windowSeconds);
}

/**
 * Bounds for the rolling packet-dedup lookup: the range of `first_seen_at` values that could
 * belong to another gateway's copy of the same mesh packet.
 *
 * `first_seen_at` is a BUCKET START, so it sits up to one window before its own rx_time, and
 * that copy's rx_time may itself be up to a window before ours. The earliest reachable value is
 * therefore rx - 2w, not rx - w. With the tighter bound, a pair straddling a bucket boundary
 * missed whenever the earlier-bucket copy was ingested first (its bucket start fell just below
 * the lower bound), so one logical packet became two rows: exactly the double-count the rolling
 * lookup exists to prevent. The upper bound of rx + w is already sufficient, since a later copy's
 * bucket start never exceeds its own rx_time.
 */
export function dedupLookupRange(rxTime: Date, windowSeconds: number): { from: Date; to: Date } {
  const wMs = windowSeconds * 1000;
  return { from: new Date(rxTime.getTime() - 2 * wMs), to: new Date(rxTime.getTime() + wMs) };
}

/** Add days to a Date (UTC-safe since Date is epoch-based). */
export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
