// Node uptime helpers (pure logic, unit-tested in test/uptime.test.ts).
//
// Two distinct notions:
//   - Availability: what fraction of time a node was online (heard). Computed from the hourly
//     reception rollups: a node is "up" in any hour it was heard by any gateway.
//   - Device uptime: the firmware's uptime_seconds counter (reported in DeviceMetrics telemetry).
//     A reboot shows up as that counter DROPPING between consecutive, time-ordered readings.

export interface UptimePoint {
  observed_at: string; // UTC "YYYY-MM-DD HH:MM:SS"
  value: number;       // uptime_seconds at that observation
}

export interface DeviceUptimeSummary {
  currentS: number | null;     // latest uptime reading (seconds since last boot)
  reboots: number;             // number of resets detected across the series
  lastRebootAt: string | null; // observed_at of the first reading after the most recent reset
  longestRunS: number;         // highest uptime value observed = longest continuous run seen
}

/**
 * Detect reboots in a time-ordered series of uptime readings. Because the series is ordered by
 * observation time, the counter only ever decreases when the node actually rebooted; a small
 * tolerance absorbs clock jitter so an identical/near-identical repeat is not counted.
 */
export function summarizeDeviceUptime(points: UptimePoint[]): DeviceUptimeSummary {
  let reboots = 0;
  let lastRebootAt: string | null = null;
  let longestRunS = 0;
  for (let i = 0; i < points.length; i++) {
    const v = points[i]!.value;
    if (v > longestRunS) longestRunS = v;
    if (i > 0 && v < points[i - 1]!.value - 60) {
      reboots++;
      lastRebootAt = points[i]!.observed_at;
    }
  }
  return {
    currentS: points.length ? points[points.length - 1]!.value : null,
    reboots,
    lastRebootAt,
    longestRunS,
  };
}

/**
 * Availability as a percentage: hours heard divided by the hours the node could have been heard
 * (the window, capped at how long the node has existed, so a brand-new node is not shown as "10%
 * up over 30 days"). Clamped to 0..100.
 */
export function availabilityPct(heardHours: number, windowHours: number, lifetimeHours: number): number {
  const denom = Math.max(1, Math.min(windowHours, lifetimeHours));
  return Math.max(0, Math.min(100, Math.round((heardHours / denom) * 100)));
}
