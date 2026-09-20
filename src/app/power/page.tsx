import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { getMeshPower, lowBatteryNodes, routerBatteryFleet } from "../../db/queries.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { fmtAge, fmtLocal } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { roleColor } from "../../lib/rx.ts";
import { cn } from "../../lib/cn.ts";
import { DbError } from "../../components/DbError.tsx";
import { AutoRefresh } from "../../components/AutoRefresh.tsx";
import { Tabs } from "../../components/Tabs.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

const POWER_LABEL: Record<string, string> = {
  battery_pct: "Battery", voltage: "Voltage", ch1_voltage: "Ch1 V", ch1_current: "Ch1 A",
  ch2_voltage: "Ch2 V", ch2_current: "Ch2 A", ch3_voltage: "Ch3 V", ch3_current: "Ch3 A",
};
function fmtPower(metric: string, v: number): string {
  if (metric === "battery_pct") return `${Math.round(v)}%`;
  if (metric.endsWith("_current")) return `${v.toFixed(1)} mA`;
  return `${v.toFixed(2)} V`;
}
const THRESHOLDS = [20, 35, 50, 75, 100];
function battColor(pct: number | null): string {
  if (pct == null) return "#6f6e67";
  if (pct >= 50) return "#3f9e63";
  if (pct >= 20) return "#e0b43a";
  return "#f04747";
}

// Consolidated power/battery view (formerly /power, /battery, /routers). One route, one nav
// entry, one module (`power`); the three former paths redirect here.
export default async function PowerPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("power"); if (__denied) return __denied;
  const sp = await searchParams;
  const rawT = Number(Array.isArray(sp.threshold) ? sp.threshold[0] : sp.threshold);
  const threshold = THRESHOLDS.includes(rawT) ? rawT : 35;

  let solar, low, routers, zone = "UTC";
  try {
    zone = (await effectiveConfig()).server.local_timezone;
    [solar, low, routers] = await Promise.all([getMeshPower(2), lowBatteryNodes(threshold, 300), routerBatteryFleet()]);
  } catch (e) {
    return <DbError error={e} />;
  }

  const barColor = (b: number) => (b <= 15 ? "bg-accent-strong" : b <= 30 ? "bg-rx-relayed" : "bg-rx-direct");
  const now = Date.now();
  const withBatt = routers.filter((r) => r.battery != null);
  const rLow = withBatt.filter((r) => Number(r.battery) < 30).length;
  const rCrit = withBatt.filter((r) => Number(r.battery) < 15).length;
  const rDying = routers.filter((r) => r.projected_dead_at && new Date(r.projected_dead_at.replace(" ", "T") + "Z").getTime() - now < 7 * 86400000).length;
  const rMains = routers.length - withBatt.length;
  const stat = (label: string, value: number | string, tone = "text-ink") => (
    <div className="card"><div className="stat-label">{label}</div><div className={`stat mt-1 text-2xl ${tone}`}>{value}</div></div>
  );

  const lowBatteryPanel = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-ink-faint">Nodes reporting battery at or below the threshold, lowest first. {low.length} node{low.length === 1 ? "" : "s"}.</p>
        <div className="flex items-center gap-1">
          {THRESHOLDS.map((t) => (
            <Link key={t} href={`/power?threshold=${t}`} className={cn("rounded-md border px-2 py-1 text-[12px]", t === threshold ? "border-accent bg-raised text-ink" : "border-line text-ink-mute hover:text-ink")}>&le;{t}%</Link>
          ))}
        </div>
      </div>
      {low.length === 0 ? (
        <div className="card text-ink-faint">No nodes at or below {threshold}% battery. Nice.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="data">
            <thead><tr><th>Node</th><th>Short</th><th>Role</th><th className="w-40">Battery</th><th className="text-right">Voltage</th><th>Reading</th><th>Last heard</th><th>Projected dark</th></tr></thead>
            <tbody>
              {low.map((r) => (
                <tr key={r.node_id}>
                  <td>
                    <Link className="text-ink hover:text-accent" href={`/nodes/${r.node_id}`}>{r.long_name ?? r.short_name ?? formatNodeId(r.node_id)}</Link>
                    <div className="mono text-[11px] text-ink-faint">{formatNodeId(r.node_id)}</div>
                  </td>
                  <td className="mono text-ink-mute">{r.short_name ?? "-"}</td>
                  <td><span className={cn(roleColor(r.role))}>{r.role ?? "unknown"}</span>{r.is_gateway ? <span className="ml-1 text-[10px] text-ink-faint">gw</span> : null}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <div className="h-3 flex-1 rounded bg-raised"><div className={cn("h-3 rounded", barColor(r.battery))} style={{ width: `${Math.max(3, Math.min(100, r.battery))}%` }} /></div>
                      <span className="w-10 text-right tabular-nums">{Math.round(r.battery)}%</span>
                    </div>
                  </td>
                  <td className="text-right tabular-nums">{r.voltage != null ? `${r.voltage.toFixed(2)} V` : "-"}</td>
                  <td className="text-ink-faint">{fmtAge(r.observed_at)} ago</td>
                  <td className="text-ink-faint">{r.last_seen_at ? `${fmtAge(r.last_seen_at)} ago` : "never"}</td>
                  <td>{r.projected_dead_at ? <span className="text-accent-strong">{fmtLocal(r.projected_dead_at, zone)}</span> : <span className="text-ink-faint">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const routersPanel = (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-faint">Routers, repeaters, and router-clients (the infrastructure that carries the mesh), lowest battery first.</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {stat("Routers", routers.length)}
        {stat("Low (<30%)", rLow, rLow ? "text-accent-strong" : "text-ink")}
        {stat("Critical (<15%)", rCrit, rCrit ? "text-accent-strong" : "text-ink")}
        {stat("Dying <7d", rDying, rDying ? "text-accent-strong" : "text-ink")}
        {stat("Mains / unknown", rMains, "text-ink-faint")}
      </div>
      {routers.length === 0 ? (
        <div className="card text-ink-faint">No router or repeater nodes seen yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {routers.map((r) => {
            const pct = r.battery == null ? null : Math.round(Number(r.battery));
            const color = battColor(pct);
            const dead = r.projected_dead_at ? new Date(r.projected_dead_at.replace(" ", "T") + "Z").getTime() : null;
            const dyingSoonRow = dead != null && dead - now < 7 * 86400000;
            return (
              <div key={r.node_id} className="card space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link className="callsign block truncate" href={`/nodes/${r.node_id}`}>{r.long_name ?? r.short_name ?? formatNodeId(r.node_id)}</Link>
                    <div className="mono text-[11px] text-ink-faint">{formatNodeId(r.node_id)} &middot; {r.role ?? "?"}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-semibold tabular-nums" style={{ color }}>{pct != null ? `${pct}%` : "-"}</div>
                    {r.voltage != null && <div className="text-[11px] text-ink-faint">{Number(r.voltage).toFixed(2)} V</div>}
                  </div>
                </div>
                <div className="h-2.5 w-full rounded bg-raised"><div className="h-2.5 rounded" style={{ width: `${pct ?? 0}%`, background: color }} /></div>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                  {r.power_profile && <span className="pill pill-off">{r.power_profile}</span>}
                  <span>heard {fmtAge(r.last_seen_at)} ago</span>
                  <span className={dyingSoonRow ? "text-accent-strong" : ""}>{r.projected_dead_at ? `dark ${fmtLocal(r.projected_dead_at, zone)}` : "stable"}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const solarPanel = (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-faint">Nodes reporting power-channel telemetry (INA219/solar sensors): battery, bus voltage, and per-channel voltage/current. Latest reading per node, last 48h.</p>
      {solar.nodes.length === 0 ? (
        <div className="card text-ink-faint">No power-channel telemetry in the last 48 hours.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="data">
            <thead><tr><th>Node</th>{solar.columns.map((c) => <th key={c} className="text-right">{POWER_LABEL[c] ?? c}</th>)}<th>Updated ({zone})</th></tr></thead>
            <tbody>
              {solar.nodes.map((n) => (
                <tr key={n.node_id}>
                  <td><Link className="callsign" href={`/nodes/${n.node_id}`}>{n.name ?? formatNodeId(n.node_id)}</Link></td>
                  {solar.columns.map((c) => (
                    <td key={c} className={cn("text-right tabular-nums", c === "battery_pct" && n.values[c] !== undefined && n.values[c]! <= 25 && "text-accent-strong")}>
                      {n.values[c] === undefined ? "-" : fmtPower(c, n.values[c]!)}
                    </td>
                  ))}
                  <td className="text-ink-mute">{fmtAge(n.observed_at)} ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="eyebrow"><span className="eyebrow-bar" />Power &amp; battery</h1>
          <p className="mt-1 text-[13px] text-ink-faint">Battery health across the mesh: low-battery nodes, router/repeater infrastructure, and power-channel/solar telemetry.</p>
        </div>
        <AutoRefresh />
      </div>
      <Tabs
        initial={(Array.isArray(sp.tab) ? sp.tab[0] : sp.tab) ?? (sp.threshold ? "low" : "solar")}
        tabs={[
          { id: "low", label: "Low battery", panel: lowBatteryPanel },
          { id: "routers", label: "Routers", panel: routersPanel },
          { id: "solar", label: "Power & solar", panel: solarPanel },
        ]}
      />
    </div>
  );
}
