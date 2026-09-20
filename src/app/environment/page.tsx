import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { getMeshEnvironment, listSensorEvents, type MeshEnvMetric } from "../../db/queries.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { fmtAge, convertTemp, tempUnitLabel, type TempUnit } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { DbError } from "../../components/DbError.tsx";
import { AutoRefresh } from "../../components/AutoRefresh.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = {
  temperature: "Temperature", humidity: "Humidity", pressure: "Pressure", iaq: "Air quality (IAQ)",
  co2: "CO2", lux: "Light", gas_resistance: "Gas resistance", wind_speed: "Wind speed", wind_direction: "Wind dir",
};

function fmtEnv(metric: string, value: number, unit: TempUnit): string {
  switch (metric) {
    case "temperature": return `${convertTemp(value, unit).toFixed(1)} ${tempUnitLabel(unit)}`;
    case "humidity": return `${Math.round(value)}%`;
    case "pressure": return `${value.toFixed(1)} hPa`;
    case "co2": return `${Math.round(value)} ppm`;
    case "lux": return `${Math.round(value)} lx`;
    case "gas_resistance": return `${Math.round(value)} ohm`;
    case "wind_speed": return `${value.toFixed(1)} m/s`;
    case "wind_direction": return `${Math.round(value)} deg`;
    default: return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}

export default async function EnvironmentPage() {
  const __denied = await moduleDenied("environment"); if (__denied) return __denied;
  let data, events, zone = "UTC", unit: TempUnit = "f";
  try {
    const cfg = await effectiveConfig();
    zone = cfg.server.local_timezone;
    unit = cfg.server.ui.temperature_unit as TempUnit;
    data = await getMeshEnvironment(1);
    // DETECTION_SENSOR_APP / ALERT_APP bodies. Both are plain text the mesh already carries and
    // HopWatch used to discard: door/motion/water-level detections and critical-alert broadcasts.
    events = await listSensorEvents({ limit: 50 });
  } catch (e) {
    return <DbError error={e} />;
  }

  const cols = data.metrics.map((m: MeshEnvMetric) => m.metric);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="eyebrow"><span className="eyebrow-bar" />Mesh weather</h1>
          <p className="mt-1 text-[13px] text-ink-faint">
            Environmental sensors reported by nodes across the mesh (latest reading per node, last 24h).
            Distinct from the external station on the <Link className="text-accent hover:underline" href="/weather">Weather</Link> page.
          </p>
        </div>
        <AutoRefresh />
      </div>

      {data.metrics.length === 0 ? (
        <div className="card text-ink-faint">No environmental sensor telemetry in the last 24 hours.</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {data.metrics.map((m) => (
              <div key={m.metric} className="card">
                <div className="stat-label">{LABEL[m.metric] ?? m.metric}</div>
                <div className="stat mt-1">{fmtEnv(m.metric, m.avg, unit)}</div>
                <div className="mt-1 text-[11px] text-ink-faint">
                  {fmtEnv(m.metric, m.min, unit)} to {fmtEnv(m.metric, m.max, unit)} &middot; {m.count} node(s)
                </div>
              </div>
            ))}
          </div>

          <div className="card overflow-x-auto">
            <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Sensor nodes</h2>
            <table className="data">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Short</th>
                  {cols.map((c) => <th key={c} className="text-right">{LABEL[c] ?? c}</th>)}
                  <th>Updated ({zone})</th>
                </tr>
              </thead>
              <tbody>
                {data.nodes.map((n) => (
                  <tr key={n.node_id}>
                    <td><Link className="callsign" href={`/nodes/${n.node_id}`}>{n.name ?? formatNodeId(n.node_id)}</Link></td>
                    <td className="mono text-ink-mute">{n.short_name ?? "-"}</td>
                    {cols.map((c) => (
                      <td key={c} className="text-right tabular-nums">{n.values[c] === undefined ? "-" : fmtEnv(c, n.values[c]!, unit)}</td>
                    ))}
                    <td className="text-ink-mute">{fmtAge(n.observed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="space-y-1">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Detections &amp; alerts</h2>
        <p className="text-[13px] text-ink-faint">
          DETECTION_SENSOR_APP and ALERT_APP broadcasts: physical-world events (door, motion, water
          level) and the mesh&apos;s critical alerts. Kept apart from chat, so they never appear in
          messages or cross the text bridge.
        </p>
      </div>
      {events.length === 0 ? (
        <div className="card text-ink-faint">No detection or alert traffic observed yet.</div>
      ) : (
        <div className="card overflow-x-auto"><table className="data">
          <thead><tr><th>When</th><th>Kind</th><th>Node</th><th>Channel</th><th>Body</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="text-ink-mute">{fmtAge(e.observed_at)}</td>
                <td className={e.kind === "alert" ? "text-accent-strong" : "text-ink"}>{e.kind}</td>
                <td><Link className="callsign" href={`/nodes/${e.node_id}`}>{e.long_name ?? e.short_name ?? formatNodeId(e.node_id)}</Link></td>
                <td className="mono text-ink-faint">{e.channel_id ?? "-"}</td>
                <td className="break-words text-ink">{e.body}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
