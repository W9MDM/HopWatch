import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// Optional NOAA SWPC space-weather ingest (off by default). Pulls geomagnetic Kp, the
// 10.7cm solar flux, and solar-wind speed, and stores one row per poll so the /propagation
// page can show current conditions and they can be correlated with propagation_events.
// Everything is parsed defensively: an endpoint that changes shape stores null, not a crash.

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** NOAA G-scale-ish label from the planetary Kp index. */
function conditionFromKp(kp: number | null): string | null {
  if (kp == null) return null;
  if (kp < 4) return "Quiet";
  if (kp < 5) return "Unsettled";
  if (kp < 6) return "G1 storm";
  if (kp < 7) return "G2 storm";
  if (kp < 8) return "G3 storm";
  if (kp < 9) return "G4 storm";
  return "G5 storm";
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "HopWatch (+https://github.com/hopwatch)", Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * The SWPC planetary-K product is an array whose first element is a header row, e.g.
 * [["time_tag","Kp","a_running","station_count"], ["2026-07-14 00:00:00","3.33",...], ...].
 * Return the most recent Kp value and its time tag.
 */
function parseKp(j: any): { kp: number | null; observedAt: Date | null } {
  if (!Array.isArray(j) || j.length < 2) return { kp: null, observedAt: null };
  const last = j[j.length - 1];
  if (!Array.isArray(last)) return { kp: null, observedAt: null };
  const kp = num(last[1]);
  const t = typeof last[0] === "string" ? new Date(last[0].replace(" ", "T") + "Z") : null;
  return { kp, observedAt: t && !Number.isNaN(t.getTime()) ? t : null };
}

export async function ingestSpaceWeather(cfg: HopWatchConfig): Promise<boolean> {
  const sw = cfg.rf.space_weather;
  if (!sw.enabled) return false;

  // Pace by the configured interval so the 30-min slow loop cannot over-poll if retuned.
  const last = await query<{ c: string | null }>(`SELECT MAX(fetched_at) c FROM space_weather_obs`);
  if (last[0]?.c) {
    const ageMin = (Date.now() - new Date(last[0].c.replace(" ", "T") + "Z").getTime()) / 60000;
    if (ageMin < sw.refresh_interval_minutes) return false;
  }

  const [kpJson, fluxJson, windJson] = await Promise.all([
    fetchJson(sw.kp_url),
    fetchJson(sw.flux_url),
    fetchJson(sw.solar_wind_url),
  ]);

  const { kp, observedAt } = parseKp(kpJson);
  const flux = num(fluxJson?.Flux);
  const wind = num(windJson?.WindSpeed);

  // Nothing usable came back: skip rather than write an all-null row.
  if (kp == null && flux == null && wind == null) return false;

  const now = new Date();
  await query(
    `INSERT INTO space_weather_obs (fetched_at, kp, kp_observed_at, solar_flux_10cm, solar_wind_kms, condition_label)
       VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE kp=VALUES(kp), kp_observed_at=VALUES(kp_observed_at),
       solar_flux_10cm=VALUES(solar_flux_10cm), solar_wind_kms=VALUES(solar_wind_kms), condition_label=VALUES(condition_label)`,
    [toMysqlUtc(now), kp, observedAt ? toMysqlUtc(observedAt) : null, flux, wind, conditionFromKp(kp)],
  );
  return true;
}
