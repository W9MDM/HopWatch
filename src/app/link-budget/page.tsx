import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { getLinkBudgets } from "../../db/queries.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { DbError } from "../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function LinkBudgetPage() {
  const __denied = await moduleDenied("link-budget"); if (__denied) return __denied;
  let rows;
  try {
    rows = await getLinkBudgets(200);
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Link budget
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          Free-space path loss and first Fresnel-zone radius per direct link, with the gap between
          expected and observed RSSI. Enable in <span className="mono">/admin/settings</span> (RF &amp; propagation);
          terrain clearance is added when an elevation source is configured.
        </p>
      </div>
      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Gateway</th>
              <th>Node</th>
              <th className="text-right">Distance</th>
              <th className="text-right">Expected loss</th>
              <th className="text-right">Fresnel r</th>
              <th className="text-right">Observed RSSI</th>
              <th className="text-right">Deficit</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-ink-faint">
                  No link-budget results yet. Enable it in /admin/settings (RF) and give nodes positions.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="mono text-ink-mute">{formatNodeId(r.node_a)}</td>
                <td>
                  <Link className="callsign" href={`/link-budget/${r.node_a}/${r.node_b}`}>
                    {r.node_name ?? formatNodeId(r.node_b)}
                  </Link>
                </td>
                <td className="text-right tabular-nums">{r.distance_km === null ? "-" : `${r.distance_km.toFixed(1)} km`}</td>
                <td className="text-right tabular-nums">{r.expected_path_loss_db === null ? "-" : `${r.expected_path_loss_db.toFixed(0)} dB`}</td>
                <td className="text-right tabular-nums">{r.fresnel_clearance === null ? "-" : `${r.fresnel_clearance.toFixed(0)} m`}</td>
                <td className="text-right tabular-nums">{r.observed_rssi === null ? "-" : `${Math.round(r.observed_rssi)} dBm`}</td>
                <td className="text-right tabular-nums text-rx-relayed">{r.deficit_db === null ? "-" : `${r.deficit_db.toFixed(0)} dB`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
