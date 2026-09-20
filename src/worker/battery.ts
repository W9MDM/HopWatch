import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";

// Battery death predictor. Fits a voltage-vs-time trend per node, classifies the
// power profile from the daily charge pattern, and forecasts time-to-dead for
// declining nodes (spec: historical/time-machine). Feeds the battery_forecast alert.
const CUTOFF_V = 3.0; // a LiPo below this is effectively dead
const MIN_POINTS = 10;

interface Pt {
  t: number; // epoch seconds
  v: number;
  hour: number; // UTC hour
}

export async function computeBatteryForecasts(): Promise<number> {
  const rows = await query<{ node_id: number; t: number; hour: number; v: number }>(
    `SELECT node_id, UNIX_TIMESTAMP(observed_at) AS t, HOUR(observed_at) AS hour, value AS v
     FROM node_telemetry
     WHERE metric='voltage' AND observed_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)
     ORDER BY node_id, observed_at`,
  );
  const byNode = new Map<number, Pt[]>();
  for (const r of rows) {
    const arr = byNode.get(r.node_id) ?? [];
    arr.push({ t: Number(r.t), v: Number(r.v), hour: Number(r.hour) });
    byNode.set(r.node_id, arr);
  }

  let n = 0;
  for (const [nodeId, pts] of byNode) {
    if (pts.length < MIN_POINTS) continue;
    const fit = linreg(pts.map((p) => p.t / 86400), pts.map((p) => p.v)); // slope in V/day
    const current = pts[pts.length - 1]!.v;
    const profile = classify(pts, fit.slope);
    let projectedDeadAt: string | null = null;
    if (fit.slope < -0.005 && current > CUTOFF_V) {
      const daysToDead = (current - CUTOFF_V) / -fit.slope;
      if (daysToDead > 0 && daysToDead < 3650) projectedDeadAt = toMysqlUtc(new Date(Date.now() + daysToDead * 86_400_000));
    }
    await query(
      `INSERT INTO battery_forecast (node_id, computed_at, power_profile, slope_v_per_day, current_voltage, projected_dead_at, confidence)
         VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE computed_at=VALUES(computed_at), power_profile=VALUES(power_profile),
         slope_v_per_day=VALUES(slope_v_per_day), current_voltage=VALUES(current_voltage),
         projected_dead_at=VALUES(projected_dead_at), confidence=VALUES(confidence)`,
      [nodeId, toMysqlUtc(new Date()), profile, fit.slope, current, projectedDeadAt, fit.r2],
    );
    n++;
  }
  return n;
}

function linreg(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

function classify(pts: Pt[], slope: number): "solar" | "mains" | "battery" | "unknown" {
  // Average voltage by hour of day; a large day/night swing implies solar charging.
  const sum = new Array<number>(24).fill(0);
  const cnt = new Array<number>(24).fill(0);
  for (const p of pts) {
    sum[p.hour]! += p.v;
    cnt[p.hour]! += 1;
  }
  const hourly = sum.map((s, h) => (cnt[h] ? s / cnt[h]! : NaN)).filter((v) => !Number.isNaN(v));
  if (hourly.length < 4) return "unknown";
  const swing = Math.max(...hourly) - Math.min(...hourly);
  const current = pts[pts.length - 1]!.v;
  if (swing > 0.15) return "solar";
  if (Math.abs(slope) < 0.02 && current > 3.9) return "mains";
  if (slope < -0.005) return "battery";
  return "unknown";
}
