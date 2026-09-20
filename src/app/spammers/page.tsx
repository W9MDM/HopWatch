import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { topSpammers } from "../../db/queries.ts";
import { fmtNum } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { DbError } from "../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Wall of spammers (Malla #50). Ranks by reception rate; muted nodes pinned on top.
export default async function SpammersPage() {
  const __denied = await moduleDenied("spammers"); if (__denied) return __denied;
  let rows;
  try {
    rows = await topSpammers(50);
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Wall of spammers
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          Ranked by reception rate. Muting is display-only and never transmits to the mesh. Manage the
          mute list from <Link className="text-accent-strong" href="/admin/mute">admin</Link>.
        </p>
      </div>
      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Node</th>
              <th>Short</th>
              <th className="text-right">Spam score (rx/hr)</th>
              <th className="text-right">Lifetime receptions</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="text-ink-faint">
                  No spam scores computed yet.
                </td>
              </tr>
            )}
            {rows.map((n) => (
              <tr key={n.node_id}>
                <td>
                  <Link className="callsign" href={`/nodes/${n.node_id}`}>
                    {n.long_name ?? n.short_name ?? formatNodeId(n.node_id)}
                  </Link>
                </td>
                <td className="mono text-ink-mute">{n.short_name ?? "-"}</td>
                <td className="text-right tabular-nums">{n.spam_score === null ? "-" : n.spam_score.toFixed(1)}</td>
                <td className="text-right tabular-nums">{fmtNum(n.total_reception_count)}</td>
                <td>
                  {n.mute_hidden ? <span className="pill pill-off">muted</span> : <span className="text-ink-faint">visible</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
