// Turn hour-of-day x day-of-week reception counts into a 7x24 grid and a best-effort
// duty-cycle profile label (spec §: traffic fingerprinting). Buckets are UTC; the
// profile is derived from the shape of activity, not absolute local time.

export interface Fingerprint {
  grid: number[][]; // [dow 0..6][hour 0..23]
  hourly: number[]; // summed across days, length 24
  total: number;
  max: number;
  profile: string;
  activeHours: number;
  avgPerActiveHour: number;
  peak12hShare: number;
}

export function buildFingerprint(rows: { dow: number; hour: number; c: number }[]): Fingerprint {
  const grid: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const hourly = new Array<number>(24).fill(0);
  let total = 0;
  let max = 0;
  for (const r of rows) {
    const dow = Math.max(0, Math.min(6, r.dow));
    const hour = Math.max(0, Math.min(23, r.hour));
    const c = Number(r.c) || 0;
    grid[dow]![hour]! += c;
    hourly[hour]! += c;
    total += c;
    if (grid[dow]![hour]! > max) max = grid[dow]![hour]!;
  }

  const activeHours = hourly.filter((h) => h > 0).length;
  const avgPerActiveHour = activeHours ? total / activeHours : 0;

  // Best contiguous 12h window share (circular), a proxy for day/night cycling.
  let best12 = 0;
  for (let start = 0; start < 24; start++) {
    let sum = 0;
    for (let k = 0; k < 12; k++) sum += hourly[(start + k) % 24]!;
    if (sum > best12) best12 = sum;
  }
  const peak12hShare = total ? best12 / total : 0;

  let profile = "insufficient data";
  if (total > 0) {
    if (peak12hShare > 0.72 && activeHours < 20) profile = "solar day-cycler";
    else if (avgPerActiveHour > 60) profile = "aggressive beaconer";
    else if (activeHours >= 20) profile = "always-on";
    else profile = "intermittent";
  }

  return { grid, hourly, total, max, profile, activeHours, avgPerActiveHour, peak12hShare };
}

export const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
