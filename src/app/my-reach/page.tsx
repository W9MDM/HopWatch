import Link from "next/link";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../auth/session.ts";
import { sessionAccess } from "../../auth/rbac.ts";
import { actorFor, reachNumIdsForUser } from "../../db/ownednodes.ts";
import { getFleetReach } from "../../db/queries.ts";
import { query } from "../../db/client.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { mapTiles } from "../../lib/maptiles.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { roleColor } from "../../lib/rx.ts";
import { FleetReachMap } from "../../components/FleetReachMap.tsx";
import { AutoRefresh } from "../../components/AutoRefresh.tsx";
import { LivePackets } from "../../components/LivePackets.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "My reach" };

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "warn" ? "text-accent-strong" : "text-ink"}`}>{value}</div>
      {sub && <div className="text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}
const dist = (km: number | null) => (km == null ? "-" : km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

function Sparkline({ data, w = 72, h = 20 }: { data: number[]; w?: number; h?: number }) {
  if (data.length < 2) return null;
  const max = Math.max(1, ...data), min = Math.min(...data), rng = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / rng) * (h - 4) - 2).toFixed(1)}`).join(" ");
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="text-accent"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}
function trendBits(cur: number, prev: number): { sym: string; cls: string; txt: string } | null {
  if (prev === 0 && cur === 0) return null;
  const dd = cur - prev;
  if (dd === 0) return { sym: "→", cls: "text-ink-faint", txt: "same as last week" };
  return dd > 0 ? { sym: "↑", cls: "text-ok", txt: `up from ${prev}` } : { sym: "↓", cls: "text-accent-strong", txt: `down from ${prev}` };
}

function SignIn() {
  return (
    <div className="mx-auto max-w-sm py-16 text-center">
      <p className="text-[13px] text-ink-mute">Sign in to see the combined reach of the nodes you have claimed.</p>
      <Link className="btn btn-primary mt-3 h-9 px-4 text-[13px]" href="/admin/login">Sign in</Link>
    </div>
  );
}

export default async function MyReachPage({ searchParams }: { searchParams: Promise<{ user?: string }> }) {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return <SignIn />;

  let fleet, tile, zone = "UTC", claimedCount = 0, viewing: string | null = null;
  try {
    const access = await sessionAccess(session);
    const actor = await actorFor(session.sub, access.admin);
    // An admin can view another user's reach via ?user=<id>. Everyone else sees their own.
    let targetId = actor?.id ?? null;
    const sp = await searchParams;
    if (access.admin && sp.user && /^\d+$/.test(sp.user) && Number(sp.user) !== actor?.id) {
      const u = await query<{ username: string }>(`SELECT username FROM admin_users WHERE id=?`, [Number(sp.user)]);
      if (u[0]) { targetId = Number(sp.user); viewing = u[0].username; }
    }
    // Nodes owned directly OR by a group the user belongs to, so a shared fleet shows here too.
    const ids = targetId ? await reachNumIdsForUser(targetId) : [];
    claimedCount = ids.length;
    [fleet, tile] = await Promise.all([getFleetReach(ids), mapTiles()]);
    zone = (await effectiveConfig()).server.local_timezone;
  } catch (e) {
    return <div className="card text-accent-strong">Failed to load reach: {(e as Error).message}</div>;
  }

  const updated = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit" }).format(new Date());
  const stamp = Date.now();

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="eyebrow"><span className="eyebrow-bar" />{viewing ? `${viewing}'s reach` : "My reach"}</div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">{viewing ? `${viewing}'s nodes at a glance` : "All my nodes at a glance"}</h1>
          <p className="mt-1 text-[13px] text-ink-mute">Every node {viewing ? "this user has" : "you have"} claimed (and group nodes), plus who hears them and who they hear, over the last {fleet.window_days} days.{viewing ? "" : " One map instead of a reach tab per node."}</p>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-ink-faint">
          <span>updated {updated}</span>
          <AutoRefresh intervalMs={300000} />
        </div>
      </div>

      {claimedCount === 0 ? (
        <div className="card text-[13px] text-ink-mute">
          {viewing
            ? <>{viewing} has no claimed or group nodes yet. Assign some from <Link className="text-accent hover:underline" href="/owned-nodes">owned nodes</Link>.</>
            : <>You have not claimed any nodes yet. Claim one from its popup on the <Link className="text-accent hover:underline" href="/coverage">coverage map</Link> or from <Link className="text-accent hover:underline" href="/owned-nodes">owned nodes</Link>, and it will show up here.</>}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
            <Stat label="Your nodes" value={String(fleet.summary.nodes_claimed)} sub={`${fleet.summary.nodes_mapped} on the map`} />
            <div className="card">
              <div className="stat-label">Unique receivers</div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold tabular-nums text-ink">{fleet.summary.unique_receivers}</span>
                {(() => { const tb = trendBits(fleet.summary.unique_receivers, fleet.trend.prev_unique_receivers); return tb ? <span className={`text-base ${tb.cls}`}>{tb.sym}</span> : null; })()}
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-1">
                <span className="text-[11px] text-ink-faint">{trendBits(fleet.summary.unique_receivers, fleet.trend.prev_unique_receivers)?.txt ?? "stations that hear you"}</span>
                <Sparkline data={fleet.trend.daily.map((x) => x.receivers)} />
              </div>
            </div>
            <Stat label="Unique neighbors" value={String(fleet.summary.unique_neighbors)} sub="node-to-node links" />
            <Stat label="Relayed-by" value={String(fleet.summary.relay_receivers)} sub="hear you via a relay only" />
            <Stat label="Max reach" value={dist(fleet.summary.max_reach_km)} sub="farthest direct link" />
            <Stat label="At risk" value={String(fleet.summary.at_risk)} sub="1 or 0 receivers" tone={fleet.summary.at_risk > 0 ? "warn" : undefined} />
            <Stat label="Best margin" value={fleet.summary.best_margin == null ? "-" : `${fleet.summary.best_margin >= 0 ? "+" : ""}${fleet.summary.best_margin.toFixed(0)} dB`} sub="strongest link headroom" />
          </div>

          {(fleet.trend.gained.length > 0 || fleet.trend.lost.length > 0) && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-line bg-raised/40 px-3 py-2 text-[12px]">
              {fleet.trend.gained.length > 0 && <div><span className="font-medium text-ok">+ gained</span> <span className="text-ink-mute">{fleet.trend.gained.map((g) => g.name ?? formatNodeId(g.id)).join(", ")}</span></div>}
              {fleet.trend.lost.length > 0 && <div><span className="font-medium text-accent-strong">- lost</span> <span className="text-ink-mute">{fleet.trend.lost.map((g) => g.name ?? formatNodeId(g.id)).join(", ")}</span></div>}
              <span className="text-ink-faint">receivers, vs the previous {fleet.window_days} days</span>
            </div>
          )}

          <section className="card space-y-2">
            <h2 className="eyebrow"><span className="eyebrow-bar" />Combined reach map</h2>
            <FleetReachMap nodes={fleet.nodes} edges={fleet.edges} relayers={fleet.relayers} tile={tile} stamp={stamp} />
          </section>

          <LivePackets nodeIds={fleet.mine.map((m) => m.id)} names={Object.fromEntries(fleet.mine.map((m) => [m.id, m.name ?? formatNodeId(m.id)]))} showFrom />


          <section className="card space-y-3">
            <h2 className="eyebrow"><span className="eyebrow-bar" />Your nodes ({fleet.mine.length})</h2>
            <div className="overflow-x-auto">
              <table className="data">
                <thead><tr><th>Node</th><th>Role</th><th className="text-right">Direct receivers</th><th className="text-right">Neighbors</th><th className="text-right">Max reach</th><th className="text-right">Best margin</th><th></th></tr></thead>
                <tbody>
                  {fleet.mine.map((m) => (
                    <tr key={m.id}>
                      <td><Link className="callsign" href={`/nodes/${m.id}/reach`}>{m.name ?? formatNodeId(m.id)}</Link>
                        <span className="ml-2 mono text-[11px] text-ink-faint">{formatNodeId(m.id)}</span>
                        {m.direct_receivers === 0
                          ? <span className="ml-2 rounded bg-accent-strong/15 px-1.5 py-0.5 text-[10px] text-accent-strong">no direct</span>
                          : m.is_spof ? <span className="ml-2 rounded bg-[#e0b43a]/15 px-1.5 py-0.5 text-[10px] text-[#e0b43a]">SPOF</span> : null}</td>
                      <td className={`text-[12px] ${roleColor(m.role)}`}>{m.role ?? "-"}</td>
                      <td className="text-right tabular-nums">{m.direct_receivers}</td>
                      <td className="text-right tabular-nums">{m.neighbors}</td>
                      <td className="text-right tabular-nums">{dist(m.max_reach_km)}</td>
                      <td className="text-right tabular-nums">{m.best_margin == null ? "-" : `${m.best_margin >= 0 ? "+" : ""}${m.best_margin.toFixed(0)} dB`}</td>
                      <td className="text-right"><Link className="text-[12px] text-accent hover:underline" href={`/nodes/${m.id}/reach`}>reach &rarr;</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-ink-faint">{fleet.mapped} of {fleet.total} nodes in view have a position. Violet markers are yours; click one to open its full reach page. <b>SPOF</b> = only one station hears it (no backup path); <b>no direct</b> = only reachable via relays.</p>
          </section>
        </>
      )}
    </div>
  );
}
