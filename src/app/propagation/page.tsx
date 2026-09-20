import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { listPropagationEvents, getSpaceWeather, type SpaceWeatherObs } from "../../db/queries.ts";
import { fmtLocal } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { DbError } from "../../components/DbError.tsx";
import { AutoRefresh } from "../../components/AutoRefresh.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tz(): Promise<string> {
  try {
    return (await effectiveConfig()).server.local_timezone;
  } catch {
    return "UTC";
  }
}

// Green when quiet, gold when unsettled, accent (red) once a geomagnetic storm is active.
function conditionClass(label: string | null): string {
  if (!label) return "text-ink-mute";
  if (label === "Quiet") return "text-ok";
  if (label === "Unsettled") return "text-gold-ink";
  return "text-accent-strong";
}

function SpaceWeatherPanel({ latest, zone }: { latest: SpaceWeatherObs | null; zone: string }) {
  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between">
        <div className="stat-label">Space weather (NOAA SWPC)</div>
        {latest && <span className="text-[11px] text-ink-faint">updated {fmtLocal(latest.fetched_at, zone)}</span>}
      </div>
      {!latest ? (
        <p className="text-[13px] text-ink-faint">
          No space-weather data yet. Enable it in <span className="mono">/admin/settings</span> (RF &amp; propagation).
        </p>
      ) : (
        <div className="flex flex-wrap gap-6">
          <div><div className="stat-label">Condition</div><div className={`text-lg font-semibold ${conditionClass(latest.condition_label)}`}>{latest.condition_label ?? "-"}</div></div>
          <div><div className="stat-label">Kp index</div><div className="text-lg font-semibold tabular-nums text-ink">{latest.kp == null ? "-" : latest.kp.toFixed(2)}</div></div>
          <div><div className="stat-label">10.7cm flux (sfu)</div><div className="text-lg font-semibold tabular-nums text-ink">{latest.solar_flux_10cm == null ? "-" : Math.round(latest.solar_flux_10cm)}</div></div>
          <div><div className="stat-label">Solar wind (km/s)</div><div className="text-lg font-semibold tabular-nums text-ink">{latest.solar_wind_kms == null ? "-" : Math.round(latest.solar_wind_kms)}</div></div>
        </div>
      )}
    </div>
  );
}

export default async function PropagationPage() {
  const __denied = await moduleDenied("propagation"); if (__denied) return __denied;
  let rows;
  try {
    rows = await listPropagationEvents(200);
  } catch (e) {
    return <DbError error={e} />;
  }
  // Space weather is best-effort context: never let it take down the events table.
  let space: SpaceWeatherObs | null = null;
  try {
    space = (await getSpaceWeather(72)).latest;
  } catch {
    space = null;
  }
  const zone = await tz();

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Propagation events
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          Tropo/ducting enhancements (a link beating its baseline) and DX (a far node first heard direct).
          Enable detection in <span className="mono">/admin/settings</span> (RF &amp; propagation).
        </p>
        </div>
        <AutoRefresh />
      </div>
      <SpaceWeatherPanel latest={space} zone={zone} />
      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Detected ({zone})</th>
              <th>Type</th>
              <th>Gateway</th>
              <th>Node</th>
              <th className="text-right">Baseline</th>
              <th className="text-right">Observed</th>
              <th className="text-right">Delta</th>
              <th className="text-right">Distance</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="text-ink-faint">
                  No propagation events logged yet.
                </td>
              </tr>
            )}
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="text-ink-mute">{fmtLocal(e.detected_at, zone)}</td>
                <td className={e.event_type === "dx_direct" ? "text-rx-direct" : "text-gold-ink"}>{e.event_type}</td>
                <td className="mono text-ink-mute">{formatNodeId(e.gateway_id)}</td>
                <td>
                  <Link className="callsign" href={`/nodes/${e.node_id}`}>
                    {e.node_name ?? formatNodeId(e.node_id)}
                  </Link>
                </td>
                <td className="text-right tabular-nums">{e.baseline_rssi === null ? "-" : Math.round(e.baseline_rssi)}</td>
                <td className="text-right tabular-nums">{e.observed_rssi === null ? "-" : Math.round(e.observed_rssi)}</td>
                <td className="text-right tabular-nums text-ok">{e.delta_db ? `+${e.delta_db.toFixed(1)}` : "-"}</td>
                <td className="text-right tabular-nums">{e.distance_km === null ? "-" : `${e.distance_km.toFixed(1)} km`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
