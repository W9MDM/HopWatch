import Link from "next/link";
import { gatewayCompare, longestDirectLinks, hopDistribution, topTalkers, airtimeHogs, linkAsymmetry, distanceDistribution, rssiVsDistance } from "../../db/queries.ts";
import { fmtNum, fmtRssi, fmtSnr } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { DbError } from "../DbError.tsx";

// RSSI vs distance scatter (log-x). Reveals the path-loss trend and outliers (tropo, bad
// antennas) at a glance. Pure SVG, no client JS.
function PathLossScatter({ points }: { points: { distance_km: number; rssi: number }[] }) {
  const W = 900, H = 320, PADL = 40, PADB = 28, PADT = 10, PADR = 12;
  const pts = points.filter((p) => p.distance_km > 0 && p.rssi < 0 && p.rssi > -140);
  if (pts.length === 0) return <p className="text-[13px] text-ink-faint">Not enough direct links with known positions yet.</p>;
  const maxKm = Math.max(...pts.map((p) => p.distance_km), 1);
  const lx = (km: number) => Math.log10(Math.max(0.05, km));
  const lxMin = lx(0.05), lxMax = lx(maxKm);
  const rMin = -130, rMax = -30;
  const px = (km: number) => PADL + ((lx(km) - lxMin) / (lxMax - lxMin || 1)) * (W - PADL - PADR);
  const py = (r: number) => PADT + (1 - (Math.max(rMin, Math.min(rMax, r)) - rMin) / (rMax - rMin)) * (H - PADT - PADB);
  const xTicks = [0.1, 0.5, 1, 2, 5, 10, 20, 50].filter((k) => k <= maxKm * 1.2);
  const yTicks = [-40, -60, -80, -100, -120];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 340 }} role="img" aria-label="RSSI versus distance">
      {yTicks.map((r) => (
        <g key={r}>
          <line x1={PADL} y1={py(r)} x2={W - PADR} y2={py(r)} stroke="currentColor" opacity={0.08} />
          <text x={4} y={py(r) + 3} fontSize={9} fill="#8a8a84">{r}</text>
        </g>
      ))}
      {xTicks.map((k) => (
        <g key={k}>
          <line x1={px(k)} y1={PADT} x2={px(k)} y2={H - PADB} stroke="currentColor" opacity={0.06} />
          <text x={px(k)} y={H - PADB + 14} fontSize={9} fill="#8a8a84" textAnchor="middle">{k < 1 ? k : `${k}km`}</text>
        </g>
      ))}
      {pts.map((p, i) => <circle key={i} cx={px(p.distance_km)} cy={py(p.rssi)} r={2.2} fill="#3f9e63" opacity={0.5} />)}
    </svg>
  );
}

// Signal & RF tab of /analytics (formerly the /analytics page body).
export async function AnalyticsPanel() {
  let compare, longest, hops, talkers, airtime, asym, distances, scatter;
  try {
    [compare, longest, hops, talkers, airtime, asym, distances, scatter] = await Promise.all([
      gatewayCompare(), longestDirectLinks(25), hopDistribution(24), topTalkers(24, 20),
      airtimeHogs(20), linkAsymmetry(20), distanceDistribution(), rssiVsDistance(2000),
    ]);
  } catch (e) {
    return <DbError error={e} />;
  }
  const maxHop = Math.max(1, ...hops.map((h) => h.c));
  const DIST_LABELS = ["0-1 km", "1-2 km", "2-5 km", "5-10 km", "10-20 km", "20-50 km", "50+ km"];
  const distRows = DIST_LABELS.map((label, i) => ({ label, c: distances.find((d) => d.bkt === i)?.c ?? 0 }));
  const maxDist = Math.max(1, ...distRows.map((d) => d.c));

  return (
    <div className="space-y-6">
      <div className="card overflow-x-auto">
        <h2 className="eyebrow mb-1"><span className="eyebrow-bar" />RSSI vs distance</h2>
        <p className="mb-2 text-[11px] text-ink-faint">Every direct (zero-hop) link with known positions. Distance is log-scaled; points high-and-right beat the path-loss trend (tropo / big antennas).</p>
        <PathLossScatter points={scatter} />
      </div>

      <div className="card">
        <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Gateway compare</h2>
        <table className="data">
          <thead><tr><th>Gateway</th><th className="text-right">Direct nodes</th><th className="text-right">Relayed nodes</th><th className="text-right">Receptions</th><th className="text-right">Avg direct RSSI</th></tr></thead>
          <tbody>
            {compare.map((g) => (
              <tr key={g.gateway_id}>
                <td>
                  <Link className="text-accent-strong" href={`/gateways/${g.gateway_id}`}>{g.gateway_name ?? formatNodeId(g.gateway_id)}</Link>
                  <div className="mono text-[11px] text-ink-faint">{formatNodeId(g.gateway_id)}</div>
                </td>
                <td className="text-right tabular-nums text-rx-direct">{fmtNum(g.direct_nodes)}</td>
                <td className="text-right tabular-nums text-rx-relayed">{fmtNum(g.relayed_nodes)}</td>
                <td className="text-right tabular-nums">{fmtNum(g.total_receptions)}</td>
                <td className="text-right tabular-nums">{g.avg_direct_rssi === null ? "-" : Math.round(g.avg_direct_rssi)}</td>
              </tr>
            ))}
            {compare.length === 0 && <tr><td colSpan={5} className="text-ink-faint">No gateway data yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Longest direct links</h2>
          <table className="data">
            <thead><tr><th>Gateway</th><th>Node</th><th className="text-right">Distance</th><th className="text-right">RSSI</th><th className="text-right">SNR</th></tr></thead>
            <tbody>
              {longest.length === 0 && <tr><td colSpan={5} className="text-ink-faint">Needs node and gateway positions.</td></tr>}
              {longest.map((l, i) => (
                <tr key={i}>
                  <td className="mono text-ink-mute">{formatNodeId(l.gateway_id)}</td>
                  <td><Link className="mono text-accent-strong" href={`/nodes/${l.node_id}`}>{l.node_name ?? formatNodeId(l.node_id)}</Link></td>
                  <td className="text-right tabular-nums">{l.distance_km.toFixed(1)} km</td>
                  <td className="text-right tabular-nums">{fmtRssi(l.last_rssi)}</td>
                  <td className="text-right tabular-nums">{fmtSnr(l.last_snr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Hop distribution (receptions, 24h)</h2>
          <p className="mb-2 text-[11px] text-ink-faint">Counts individual RF receptions in the last 24h, not distinct nodes.</p>
          <div className="space-y-1">
            {hops.length === 0 && <p className="text-[13px] text-ink-faint">No RF receptions with hop metadata.</p>}
            {hops.map((h) => (
              <div key={h.hops} className="flex items-center gap-2 text-[13px]">
                <span className="w-16 text-ink-mute">{h.hops === 0 ? "direct" : `${h.hops} hop`}</span>
                <div className="h-3 flex-1 rounded bg-raised"><div className="h-3 rounded bg-rx-direct" style={{ width: `${Math.round((h.c / maxHop) * 100)}%` }} /></div>
                <span className="w-16 text-right tabular-nums text-ink-faint">{fmtNum(h.c)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Direct-link distance distribution</h2>
          <p className="mb-2 text-[11px] text-ink-faint">Confirmed direct gateway-to-node links by distance (needs positions on both ends).</p>
          <div className="space-y-1">
            {distRows.every((d) => d.c === 0) && <p className="text-[13px] text-ink-faint">No positioned direct links yet.</p>}
            {distRows.map((d) => (
              <div key={d.label} className="flex items-center gap-2 text-[13px]">
                <span className="w-16 text-ink-mute">{d.label}</span>
                <div className="h-3 flex-1 rounded bg-raised"><div className="h-3 rounded bg-rx-direct" style={{ width: `${Math.round((d.c / maxDist) * 100)}%` }} /></div>
                <span className="w-16 text-right tabular-nums text-ink-faint">{fmtNum(d.c)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Top talkers (24h)</h2>
          <table className="data">
            <thead><tr><th>Node</th><th className="text-right">Packets</th><th className="text-right">Receptions</th></tr></thead>
            <tbody>
              {talkers.length === 0 && <tr><td colSpan={3} className="text-ink-faint">No data.</td></tr>}
              {talkers.map((t) => (
                <tr key={t.node_id}>
                  <td><Link className="callsign" href={`/nodes/${t.node_id}`}>{t.long_name ?? formatNodeId(t.node_id)}</Link></td>
                  <td className="text-right tabular-nums">{fmtNum(t.packets)}</td>
                  <td className="text-right tabular-nums">{fmtNum(t.receptions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Airtime hogs (air_util_tx)</h2>
          <table className="data">
            <thead><tr><th>Node</th><th className="text-right">Air util TX</th></tr></thead>
            <tbody>
              {airtime.length === 0 && <tr><td colSpan={2} className="text-ink-faint">No telemetry.</td></tr>}
              {airtime.map((a) => (
                <tr key={a.node_id}>
                  <td><Link className="callsign" href={`/nodes/${a.node_id}`}>{a.long_name ?? formatNodeId(a.node_id)}</Link></td>
                  <td className="text-right tabular-nums text-rx-relayed">{a.air_util_tx.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Link asymmetry</h2>
        <p className="mb-3 text-[11px] text-ink-faint">Reciprocal direct links (each node heard the other) ranked by RSSI difference.</p>
        <table className="data">
          <thead><tr><th>Node A</th><th>Node B</th><th className="text-right">A hears B</th><th className="text-right">B hears A</th><th className="text-right">Delta</th></tr></thead>
          <tbody>
            {asym.length === 0 && <tr><td colSpan={5} className="text-ink-faint">No reciprocal direct links yet.</td></tr>}
            {asym.map((r, i) => (
              <tr key={i}>
                <td><Link className="mono text-accent-strong" href={`/nodes/${r.a}`}>{r.a_name ?? formatNodeId(r.a)}</Link></td>
                <td><Link className="mono text-accent-strong" href={`/nodes/${r.b}`}>{r.b_name ?? formatNodeId(r.b)}</Link></td>
                <td className="text-right tabular-nums">{fmtRssi(r.rssi_ab)}</td>
                <td className="text-right tabular-nums">{fmtRssi(r.rssi_ba)}</td>
                <td className="text-right tabular-nums text-rx-relayed">{r.delta.toFixed(0)} dB</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
