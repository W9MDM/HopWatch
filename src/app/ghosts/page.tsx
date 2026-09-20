import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { ghostNodes } from "../../db/queries.ts";
import { fmtAge, fmtLocal, fmtRssi, fmtSnr } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { DbError } from "../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tz(): Promise<string> {
  try {
    return (await effectiveConfig()).server.local_timezone;
  } catch {
    return "UTC";
  }
}

type SP = Record<string, string | string[] | undefined>;

export default async function GhostsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("ghosts"); if (__denied) return __denied;
  const sp = await searchParams;
  const maxRaw = Array.isArray(sp.max) ? sp.max[0] : sp.max;
  const max = Math.max(1, Math.min(50, Number(maxRaw) || 3));

  let rows;
  try {
    rows = await ghostNodes(max, 300);
  } catch (e) {
    return <DbError error={e} />;
  }
  const zone = await tz();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="eyebrow">
            <span className="eyebrow-bar" />
            Ghost node hunter
          </h1>
          <p className="mt-1 text-[13px] text-ink-faint">
            Nodes heard {max} time{max === 1 ? "" : "s"} or fewer. Supports spoof and propagation review.
          </p>
        </div>
        <form method="get" className="flex items-end gap-2">
          <label className="space-y-1.5">
            <span className="block stat-label">Max receptions</span>
            <input
              name="max"
              defaultValue={max}
              className="h-9 w-24 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none"
            />
          </label>
          <button className="btn btn-primary h-9 px-4 text-[13px]" type="submit">
            Apply
          </button>
        </form>
      </div>

      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Node</th>
              <th>Short</th>
              <th className="text-right">Receptions</th>
              <th>Heard by</th>
              <th className="text-right">Last RSSI</th>
              <th className="text-right">Last SNR</th>
              <th>First heard</th>
              <th>Last heard</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="text-ink-faint">
                  No ghost nodes at this threshold.
                </td>
              </tr>
            )}
            {rows.map((g) => (
              <tr key={g.node_id}>
                <td>
                  <Link className="callsign" href={`/nodes/${g.node_id}`}>
                    {g.long_name ?? g.short_name ?? formatNodeId(g.node_id)}
                  </Link>
                </td>
                <td className="mono text-ink-mute">{g.short_name ?? "-"}</td>
                <td className="text-right tabular-nums">{g.total_reception_count}</td>
                <td className="mono text-ink-mute">{g.gateway_id ? formatNodeId(g.gateway_id) : "-"}</td>
                <td className="text-right tabular-nums">{fmtRssi(g.last_rssi)}</td>
                <td className="text-right tabular-nums">{fmtSnr(g.last_snr)}</td>
                <td className="text-ink-faint">{fmtLocal(g.first_seen_at, zone)}</td>
                <td className="text-ink-mute">{fmtAge(g.last_seen_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
