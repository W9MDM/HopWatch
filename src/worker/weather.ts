import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// Optional NWS/METAR weather ingest (off by default). Pulls the latest observation
// per configured station and stores it alongside reception data for RF correlation.
export async function ingestWeather(cfg: HopWatchConfig): Promise<number> {
  const w = (cfg.rf as any)?.weather ?? {};
  if (!w.enabled || !Array.isArray(w.stations) || w.stations.length === 0) return 0;

  let stored = 0;
  for (const station of w.stations as string[]) {
    try {
      const res = await fetch(`https://api.weather.gov/stations/${encodeURIComponent(station)}/observations/latest`, {
        headers: { "User-Agent": "HopWatch (+https://github.com/hopwatch)", Accept: "application/geo+json" },
      });
      if (!res.ok) continue;
      const j: any = await res.json();
      const p = j?.properties;
      if (!p?.timestamp) continue;
      await query(
        `INSERT INTO weather_obs (station_id, observed_at, temp_c, humidity, pressure_hpa, wind_speed, precip)
           VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE temp_c=VALUES(temp_c), humidity=VALUES(humidity),
           pressure_hpa=VALUES(pressure_hpa), wind_speed=VALUES(wind_speed), precip=VALUES(precip)`,
        [
          station,
          toMysqlUtc(new Date(p.timestamp)),
          num(p.temperature?.value),
          num(p.relativeHumidity?.value),
          p.barometricPressure?.value != null ? Number(p.barometricPressure.value) / 100 : null, // Pa -> hPa
          num(p.windSpeed?.value),
          num(p.precipitationLastHour?.value),
        ],
      );
      stored++;
    } catch (e) {
      console.error(`[worker] weather ${station} failed: ${(e as Error).message}`);
    }
  }
  return stored;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
