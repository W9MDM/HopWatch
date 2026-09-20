import { moduleDenied } from "../../components/ModuleGate.tsx";
import { getWeatherReport } from "../../db/queries.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { DbError } from "../../components/DbError.tsx";
import { TelemetryChart, type Series } from "../../components/TelemetryChart.tsx";
import { convertTemp, tempUnitLabel, type TempUnit } from "../../lib/format.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_HOURS = 720; // 30 days

/** Pearson correlation over paired samples; null if fewer than 3 pairs or no variance. */
function pearson(pairs: [number, number][]): number | null {
  const n = pairs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  const cov = n * sxy - sx * sy;
  const dx = n * sxx - sx * sx, dy = n * syy - sy * sy;
  if (dx <= 0 || dy <= 0) return null;
  return cov / Math.sqrt(dx * dy);
}

export default async function WeatherPage() {
  const __denied = await moduleDenied("weather"); if (__denied) return __denied;
  let data, unit: TempUnit = "f";
  try {
    data = await getWeatherReport(WINDOW_HOURS);
    unit = (await effectiveConfig()).server.ui.temperature_unit;
  } catch (e) {
    return <DbError error={e} />;
  }

  const rssi: Series = {
    label: "Mesh avg RSSI (dBm)",
    color: "#3f9e63",
    points: data.rssi.filter((r) => r.avg_rssi !== null).map((r) => ({ t: r.t, v: Number(r.avg_rssi) })),
  };
  const temp: Series = {
    label: `Temperature (${tempUnitLabel(unit)})`,
    color: "#e0b43a",
    points: data.weather.filter((w) => w.temp_c !== null).map((w) => ({ t: w.observed_at, v: convertTemp(Number(w.temp_c), unit) })),
  };
  const pressure: Series = {
    label: "Pressure (hPa)",
    color: "#5bb37e",
    points: data.weather.filter((w) => w.pressure_hpa !== null).map((w) => ({ t: w.observed_at, v: Number(w.pressure_hpa) })),
  };

  // Correlate temperature vs mesh RSSI on shared hourly buckets (unit-independent: r is
  // invariant to the C->F linear transform, so we pair raw temp with the hourly RSSI mean).
  const rssiByHour = new Map(data.rssi.filter((r) => r.avg_rssi !== null).map((r) => [r.t.slice(0, 13), Number(r.avg_rssi)]));
  const tempByHour = new Map<string, number[]>();
  for (const w of data.weather) {
    if (w.temp_c === null) continue;
    const h = w.observed_at.slice(0, 13);
    (tempByHour.get(h) ?? tempByHour.set(h, []).get(h)!).push(Number(w.temp_c));
  }
  const pairs: [number, number][] = [];
  for (const [h, temps] of tempByHour) {
    const r = rssiByHour.get(h);
    if (r === undefined) continue;
    pairs.push([temps.reduce((a, b) => a + b, 0) / temps.length, r]);
  }
  const corr = pearson(pairs);
  const corrStrength = corr === null ? null : Math.abs(corr) < 0.2 ? "negligible" : Math.abs(corr) < 0.4 ? "weak" : Math.abs(corr) < 0.6 ? "moderate" : "strong";

  const hasWeather = data.weather.length > 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Weather correlation
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          RSSI variance against temperature and pressure over the last 30 days. Enable ingest in{" "}
          <span className="mono">/admin/settings</span> (RF &amp; propagation) with a station list.
        </p>
      </div>

      {!hasWeather && <div className="card text-ink-faint">No weather observations. Enable weather in /admin/settings (RF) and set stations.</div>}

      {hasWeather && (
        <div className="card flex flex-wrap items-center gap-x-6 gap-y-1">
          <span className="eyebrow"><span className="eyebrow-bar" />RSSI vs temperature</span>
          {corr === null ? (
            <span className="text-[13px] text-ink-faint">Not enough overlapping hourly data yet to correlate.</span>
          ) : (
            <span className="text-[13px] text-ink-mute">
              Pearson r = <span className="text-ink">{corr.toFixed(2)}</span>
              <span className="ml-2 text-ink-faint">({corrStrength} {corr >= 0 ? "positive" : "negative"}, n={pairs.length} hours)</span>
            </span>
          )}
        </div>
      )}

      <div className="card">
        <h2 className="eyebrow mb-2">
          <span className="eyebrow-bar" />
          Mesh avg RSSI
        </h2>
        <TelemetryChart series={rssi} />
      </div>
      {hasWeather && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="card">
            <h2 className="eyebrow mb-2">
              <span className="eyebrow-bar" />
              Temperature
            </h2>
            <TelemetryChart series={temp} />
          </div>
          <div className="card">
            <h2 className="eyebrow mb-2">
              <span className="eyebrow-bar" />
              Pressure
            </h2>
            <TelemetryChart series={pressure} />
          </div>
        </div>
      )}
    </div>
  );
}
