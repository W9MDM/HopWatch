import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { gatewayCompare, uptimeLeaders, altitudeLeaders, type LeaderRow } from "../../db/queries.ts";
import { operatorScoreboard, type OperatorScore } from "../../db/ownednodes.ts";
import { fmtNum } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { cn } from "../../lib/cn.ts";
import { DbError } from "../../components/DbError.tsx";

function humanUptime(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function Leaderboard({ title, rows, fmt }: { title: string; rows: LeaderRow[]; fmt: (v: number) => string }) {
  return (
    <div className="card overflow-x-auto">
      <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />{title}</h2>
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-faint">No data yet.</p>
      ) : (
        <table className="data">
          <thead><tr><th className="text-right">#</th><th>Node</th><th>Short</th><th className="text-right">Value</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.node_id}>
                <td className="text-right tabular-nums text-ink-faint">{i + 1}</td>
                <td><Link className="callsign" href={`/nodes/${r.node_id}`}>{r.name ?? formatNodeId(r.node_id)}</Link></td>
                <td className="mono text-ink-mute">{r.short_name ?? "-"}</td>
                <td className="text-right tabular-nums">{fmt(Number(r.value))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANK = ["text-gold-ink", "text-ink", "text-rx-relayed"]; // 1st gold, 2nd/3rd muted-ish

export default async function ScoreboardPage() {
  const __denied = await moduleDenied("scoreboard"); if (__denied) return __denied;

  let operators: OperatorScore[];
  let gateways, uptime: LeaderRow[], altitude: LeaderRow[];
  try {
    [operators, gateways, uptime, altitude] = await Promise.all([operatorScoreboard(100), gatewayCompare(), uptimeLeaders(15), altitudeLeaders(15)]);
  } catch (e) {
    return <DbError error={e} />;
  }
  const workhorses = [...gateways].sort((a, b) => Number(b.total_receptions) - Number(a.total_receptions)).slice(0, 20);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow"><span className="eyebrow-bar" />Scoreboard</h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          Who keeps the mesh running: operators by the nodes they run, and the gateways carrying the most traffic.
        </p>
      </div>

      <div className="card overflow-x-auto">
        <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Top operators</h2>
        {operators.length === 0 ? (
          <p className="text-[13px] text-ink-faint">No claimed nodes yet. Claim nodes from the coverage map or <Link className="text-accent hover:underline" href="/owned-nodes">owned nodes</Link> to appear here.</p>
        ) : (
          <table className="data">
            <thead><tr><th className="text-right">#</th><th>Operator</th><th className="text-right">Nodes</th><th className="text-right">Gateways</th><th className="text-right">Planned</th><th className="text-right">Open issues</th></tr></thead>
            <tbody>
              {operators.map((o, i) => (
                <tr key={o.username}>
                  <td className={cn("text-right tabular-nums font-semibold", RANK[i] ?? "text-ink-faint")}>{i + 1}</td>
                  <td>{o.username}</td>
                  <td className="text-right tabular-nums">{fmtNum(o.nodes)}</td>
                  <td className="text-right tabular-nums">{fmtNum(o.gateways)}</td>
                  <td className="text-right tabular-nums text-ink-mute">{fmtNum(o.planned)}</td>
                  <td className="text-right tabular-nums"><span className={Number(o.open_issues) > 0 ? "text-accent-strong" : "text-ink-faint"}>{fmtNum(o.open_issues)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card overflow-x-auto">
        <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Workhorse gateways</h2>
        {workhorses.length === 0 ? (
          <p className="text-[13px] text-ink-faint">No gateway activity yet.</p>
        ) : (
          <table className="data">
            <thead><tr><th className="text-right">#</th><th>Gateway</th><th className="text-right">Receptions</th><th className="text-right">Nodes heard direct</th><th className="text-right">Avg direct RSSI</th></tr></thead>
            <tbody>
              {workhorses.map((g, i) => (
                <tr key={g.gateway_id}>
                  <td className={cn("text-right tabular-nums font-semibold", RANK[i] ?? "text-ink-faint")}>{i + 1}</td>
                  <td>
                    <Link className="callsign" href={`/gateways/${g.gateway_id}`}>{g.gateway_name ?? formatNodeId(g.gateway_id)}</Link>
                  </td>
                  <td className="text-right tabular-nums">{fmtNum(Number(g.total_receptions))}</td>
                  <td className="text-right tabular-nums">{fmtNum(Number(g.direct_nodes))}</td>
                  <td className="text-right tabular-nums text-ink-mute">{g.avg_direct_rssi == null ? "-" : `${Math.round(g.avg_direct_rssi)} dBm`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Leaderboard title="Longest uptime" rows={uptime} fmt={humanUptime} />
        <Leaderboard title="Highest altitude" rows={altitude} fmt={(v) => `${Math.round(v)} m`} />
      </div>
    </div>
  );
}
