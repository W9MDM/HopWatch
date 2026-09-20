import Link from "next/link";
import { moduleDenied } from "../../../../components/ModuleGate.tsx";
import { getNodeReach } from "../../../../db/queries.ts";
import { effectiveConfig } from "../../../../db/appsettings.ts";
import { mapTiles } from "../../../../lib/maptiles.ts";
import { fmtLocal } from "../../../../lib/format.ts";
import { roleColor } from "../../../../lib/rx.ts";
import { formatNodeId } from "../../../../meshtastic/types.ts";
import { ReachMap } from "../../../../components/ReachMap.tsx";
import { NodeTabs } from "../../../../components/NodeTabs.tsx";
import { LivePackets } from "../../../../components/LivePackets.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Node reach" };

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</div>
      {sub && <div className="text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}

// Tiny inline sparkline (pure SVG, no dependency) for the daily direct-receiver trend.
function Sparkline({ data, w = 72, h = 20 }: { data: number[]; w?: number; h?: number }) {
  if (data.length < 2) return null;
  const max = Math.max(1, ...data), min = Math.min(...data), rng = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / rng) * (h - 4) - 2).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="text-accent">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// Up/down/flat vs the previous period. Arrows are not dashes (Rule 3 ok).
function trendBits(cur: number, prev: number): { sym: string; cls: string; txt: string } | null {
  if (prev === 0 && cur === 0) return null;
  const dd = cur - prev;
  if (dd === 0) return { sym: "→", cls: "text-ink-faint", txt: "same as last week" };
  return dd > 0 ? { sym: "↑", cls: "text-ok", txt: `up from ${prev}` } : { sym: "↓", cls: "text-accent-strong", txt: `down from ${prev}` };
}

const gradeTone = (g: string) =>
  g === "A" || g === "B" ? { bg: "bg-ok/15", text: "text-ok" }
  : g === "C" ? { bg: "bg-[#e0b43a]/15", text: "text-[#e0b43a]" }
  : { bg: "bg-accent-strong/15", text: "text-accent-strong" };

// Link-margin band: headroom above the demod floor. Green solid, amber ok, red marginal.
const marginTone = (m: number | null) =>
  m == null ? "text-ink-faint" : m >= 6 ? "text-ok" : m >= 2 ? "text-[#e0b43a]" : "text-accent-strong";

export default async function NodeReachPage({ params }: { params: Promise<{ id: string }> }) {
  const __denied = await moduleDenied("nodes"); if (__denied) return __denied;
  const { id } = await params;
  const nodeId = Number(id);

  let reach, zone = "UTC", tile;
  try {
    [reach, tile] = await Promise.all([getNodeReach(nodeId), mapTiles()]);
    zone = (await effectiveConfig()).server.local_timezone;
  } catch (e) {
    return <div className="card text-accent-strong">Failed to load reach: {(e as Error).message}</div>;
  }
  if (!reach) return <div className="card text-ink-mute">Unknown node {formatNodeId(nodeId)}.</div>;

  const name = reach.node.long_name ?? reach.node.short_name ?? formatNodeId(nodeId);
  const s = reach.summary;
  const dist = (km: number | null) => (km == null ? "-" : km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-ink">
          {name} <span className={`text-[13px] ${roleColor(reach.node.role)}`}>{reach.node.role ?? ""}</span>
        </h1>
        <p className="mt-1 text-[13px] text-ink-mute">
          How far this node&apos;s transmissions propagate, over the last {reach.window_days} days.
          <span className="ml-1 mono text-ink-faint">{formatNodeId(nodeId)}</span>
        </p>
      </div>

      <NodeTabs nodeId={nodeId} active="reach" />

      {(() => {
        const t = gradeTone(s.grade);
        return (
          <section className="card flex flex-wrap items-center gap-4">
            <div className={`grid h-16 w-16 shrink-0 place-items-center rounded-xl ${t.bg}`}>
              <span className={`text-3xl font-bold ${t.text}`}>{s.grade}</span>
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-[14px] font-medium text-ink">{s.grade_reason} <span className="text-ink-faint">({s.grade_score}/100)</span></div>
              <ul className="space-y-0.5 text-[12px] text-ink-mute">
                {reach.tips.map((tip, i) => <li key={i} className="flex gap-1.5"><span className="text-accent">&rsaquo;</span>{tip}</li>)}
              </ul>
            </div>
          </section>
        );
      })()}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="card">
          <div className="stat-label">Direct receivers</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums text-ink">{s.direct_receivers}</span>
            {(() => { const tb = trendBits(s.direct_receivers, reach.trend.prev_direct_receivers); return tb ? <span className={`text-base ${tb.cls}`}>{tb.sym}</span> : null; })()}
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-1">
            <span className="text-[11px] text-ink-faint">{trendBits(s.direct_receivers, reach.trend.prev_direct_receivers)?.txt ?? "heard at 0 hops"}</span>
            <Sparkline data={reach.trend.daily.map((x) => x.receivers)} />
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Redundancy</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${s.is_spof ? "text-accent-strong" : "text-ink"}`}>{s.is_spof ? "1 only" : `${s.direct_receivers}×`}</div>
          <div className="text-[11px] text-ink-faint">{s.is_spof ? "single point of failure" : s.top_gateway_share != null ? `top carries ${Math.round(s.top_gateway_share * 100)}%` : "independent gateways"}</div>
        </div>
        <Stat label="Neighbor degree" value={String(s.neighbor_degree)} sub={s.degree_rank ? `#${s.degree_rank} of ${s.nodes_ranked}` : undefined} />
        <Stat label="Bidirectional" value={String(s.bidirectional_links)} sub="two-way links" />
        <Stat label="Max reach" value={dist(s.max_distance_km)} sub="farthest receiver" />
        <Stat label="Heard relayed" value={s.heard_relayed.toLocaleString()} sub="via a relay" />
      </div>

      {(reach.trend.gained.length > 0 || reach.trend.lost.length > 0) && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-line bg-raised/40 px-3 py-2 text-[12px]">
          {reach.trend.gained.length > 0 && <div><span className="font-medium text-ok">+ gained</span> <span className="text-ink-mute">{reach.trend.gained.map((g) => g.name ?? formatNodeId(g.id)).join(", ")}</span></div>}
          {reach.trend.lost.length > 0 && <div><span className="font-medium text-accent-strong">- lost</span> <span className="text-ink-mute">{reach.trend.lost.map((g) => g.name ?? formatNodeId(g.id)).join(", ")}</span></div>}
          <span className="text-ink-faint">vs the previous {reach.window_days} days</span>
        </div>
      )}

      <section className="card space-y-2">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Reach map</h2>
        <ReachMap node={{ lat: reach.node.lat, lon: reach.node.lon, name }} receivers={reach.receivers} relayers={reach.relayers} tile={tile} />
      </section>

      <LivePackets nodeIds={[nodeId]} />

      <section className="card space-y-3">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Direct receivers ({reach.receivers.length})</h2>
        <p className="text-[12px] text-ink-faint">Gateways that heard this node directly (0 hops) in the window. <b>Margin</b> is SNR headroom above the ~{s.demod_floor_db} dB demod floor for {s.modem_preset ?? "LongFast"} (green solid, amber ok, red marginal): a link near 0 dB is one rainstorm from gone.</p>
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>Receiver</th><th className="text-right">Heard</th><th className="text-right">Avg SNR</th><th className="text-right">Margin</th><th className="text-right">Avg RSSI</th><th className="text-right">Distance</th><th>Last</th></tr></thead>
            <tbody>
              {reach.receivers.length === 0 && <tr><td colSpan={7} className="text-ink-faint">No direct receptions in this window.</td></tr>}
              {reach.receivers.map((r) => {
                const margin = r.avg_snr != null ? r.avg_snr - s.demod_floor_db : null;
                return (
                <tr key={r.gateway_id}>
                  <td>{r.owner_node_id
                    ? <Link className="text-accent-strong" href={`/nodes/${r.owner_node_id}`}>{r.name ?? formatNodeId(r.owner_node_id)}</Link>
                    : <Link className="mono text-accent-strong" href={`/gateways/${r.gateway_id}`}>{r.name ?? formatNodeId(r.gateway_id)}</Link>}</td>
                  <td className="text-right tabular-nums">{r.count.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{r.avg_snr == null ? "-" : `${r.avg_snr.toFixed(1)} dB`}</td>
                  <td className={`text-right tabular-nums font-medium ${marginTone(margin)}`}>{margin == null ? "-" : `${margin >= 0 ? "+" : ""}${margin.toFixed(1)} dB`}</td>
                  <td className="text-right tabular-nums">{r.avg_rssi == null ? "-" : `${Math.round(r.avg_rssi)} dBm`}</td>
                  <td className="text-right tabular-nums">{dist(r.distance_km)}</td>
                  <td className="text-ink-faint">{fmtLocal(r.last_at, zone)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {reach.relayers.length > 0 && (
        <section className="card space-y-3">
          <h2 className="eyebrow"><span className="eyebrow-bar" />Relayed by ({reach.relayers.length})</h2>
          <p className="text-[12px] text-ink-faint">Gateways that carry this node&apos;s traffic <b>via a relay</b> (they hear it, but not directly at 0 hops). This is the node&apos;s wider footprint - especially for a router/repeater whose job is relaying. Toggle the relayed-by layer on the map to see them. Not a direct RF link, so no distance is implied.</p>
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Gateway</th><th className="text-right">Relayed</th><th>Last</th></tr></thead>
              <tbody>
                {reach.relayers.slice(0, 60).map((r) => (
                  <tr key={r.gateway_id}>
                    <td>{r.owner_node_id
                      ? <Link className="text-accent-strong" href={`/nodes/${r.owner_node_id}`}>{r.name ?? formatNodeId(r.owner_node_id)}</Link>
                      : <Link className="mono text-accent-strong" href={`/gateways/${r.gateway_id}`}>{r.name ?? formatNodeId(r.gateway_id)}</Link>}</td>
                    <td className="text-right tabular-nums">{r.count.toLocaleString()}</td>
                    <td className="text-ink-faint">{fmtLocal(r.last_at, zone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Node-to-node links ({reach.links.length})</h2>
        <p className="text-[12px] text-ink-faint">NeighborInfo adjacency: which nodes this one hears and which hear it back. Two-way links are the reliable ones.</p>
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>Neighbor</th><th>Link</th><th className="text-right">SNR (out / in)</th><th>Updated</th></tr></thead>
            <tbody>
              {reach.links.length === 0 && <tr><td colSpan={4} className="text-ink-faint">No NeighborInfo links in this window.</td></tr>}
              {reach.links.map((l) => (
                <tr key={l.other}>
                  <td><Link className="text-accent-strong" href={`/nodes/${l.other}`}>{l.name ?? formatNodeId(l.other)}</Link>
                    {l.role && <span className={`ml-2 text-[11px] ${roleColor(l.role)}`}>{l.role}</span>}</td>
                  <td>{l.bidir
                    ? <span className="pill pill-on">two-way</span>
                    : l.we_hear ? <span className="text-ink-mute">we hear them</span> : <span className="text-ink-mute">they hear us</span>}</td>
                  <td className="text-right tabular-nums">
                    {l.snr_out == null ? "-" : `${l.snr_out.toFixed(1)}`} / {l.snr_in == null ? "-" : `${l.snr_in.toFixed(1)}`} dB
                  </td>
                  <td className="text-ink-faint">{fmtLocal(l.updated_at, zone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
