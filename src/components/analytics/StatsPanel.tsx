import Link from "next/link";
import {
  statsTotals, meshTrends, packetsByDay, packetTypes, topTalkers, busiestLinks, channelStats,
  noiseFloorTrend, snrDistribution, trafficByHourCategory,
} from "../../db/queries.ts";
import { fmtNum } from "../../lib/format.ts";
import { portName } from "../../meshtastic/portnum.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { DbError } from "../DbError.tsx";

function Bars({ rows, color = "bg-rx-direct", unit }: { rows: { label: string; c: number }[]; color?: string; unit?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.c));
  return (
    <div className="space-y-1.5">
      {rows.length === 0 && <p className="text-[13px] text-ink-faint">No data.</p>}
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-[13px]">
          <span className="w-40 truncate text-ink-mute" title={r.label}>{r.label}</span>
          <div className="h-3 flex-1 rounded bg-raised"><div className={`h-3 rounded ${color}`} style={{ width: `${Math.round((r.c / max) * 100)}%` }} /></div>
          <span className="w-16 text-right tabular-nums text-ink-faint">{unit ? unit(r.c) : fmtNum(r.c)}</span>
        </div>
      ))}
    </div>
  );
}

function Sparkline({ values, color = "#3f9e63" }: { values: number[]; color?: string }) {
  const W = 480, H = 48;
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return <div className="flex h-12 items-center text-[11px] text-ink-faint">not enough data</div>;
  const min = Math.min(...clean), max = Math.max(...clean), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - ((Number.isFinite(v) ? v : min) - min) / span * H}`).join(" ");
  return <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 48 }} preserveAspectRatio="none"><polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" /></svg>;
}

const SNR_LABELS = ["Excellent (>= 10 dB)", "Good (5 to 10)", "Fair (0 to 5)", "Weak (-5 to 0)", "Marginal (-10 to -5)", "Very weak (< -10)"];

const TRAFFIC_CATS = [
  { key: "Text", color: "#3f9e63", ports: new Set([1, 7]) },
  { key: "Position", color: "#5bb37e", ports: new Set([3]) },
  { key: "Telemetry", color: "#e0b43a", ports: new Set([67]) },
  { key: "NodeInfo", color: "#6f8f5a", ports: new Set([4]) },
  { key: "Traceroute", color: "#a4a39c", ports: new Set([70]) },
];
const OTHER_COLOR = "#6f6e67";
// Coerce: the driver may hand back port_num as a string, and Set(number).has(string) is false,
// which would drop everything into "Other" (all-grey chart).
const catOf = (port: number | string) => { const p = Number(port); return TRAFFIC_CATS.find((c) => c.ports.has(p))?.key ?? "Other"; };
const catColor = (k: string) => TRAFFIC_CATS.find((c) => c.key === k)?.color ?? OTHER_COLOR;

function StackedTraffic({ rows }: { rows: { bucket: string; port_num: number; c: number }[] }) {
  const buckets = [...new Set(rows.map((r) => r.bucket))];
  if (buckets.length === 0) return <p className="text-[13px] text-ink-faint">No traffic in the last 24h.</p>;
  const order = [...TRAFFIC_CATS.map((c) => c.key), "Other"];
  const byBucket = new Map<string, Record<string, number>>(buckets.map((b) => [b, {}]));
  for (const r of rows) { const m = byBucket.get(r.bucket)!; const k = catOf(r.port_num); m[k] = (m[k] ?? 0) + Number(r.c); }
  const totals = buckets.map((b) => order.reduce((s, k) => s + (byBucket.get(b)![k] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const W = 900, H = 200, PADB = 4;
  const bw = W / buckets.length;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 220 }} preserveAspectRatio="none">
        {buckets.map((b, i) => {
          let y = H - PADB; const m = byBucket.get(b)!;
          return (
            <g key={b}>
              {order.map((k) => { const v = m[k] ?? 0; if (!v) return null; const h = (v / max) * (H - PADB); y -= h; return <rect key={k} x={i * bw + 0.5} y={y} width={Math.max(0.5, bw - 1)} height={h} fill={catColor(k)} />; })}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-ink-faint">
        {order.map((k) => <span key={k} className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: catColor(k) }} />{k}</span>)}
      </div>
    </div>
  );
}

// Traffic & totals tab of /analytics (formerly the /stats page).
export async function StatsPanel() {
  let totals, hourly, daily, ptypes, talkers, links, rooms, noise, snr, traffic;
  try {
    [totals, hourly, daily, ptypes, talkers, links, rooms, noise, snr, traffic] = await Promise.all([
      statsTotals(), meshTrends(48), packetsByDay(30), packetTypes(168), topTalkers(24, 20),
      busiestLinks(20), channelStats(24), noiseFloorTrend(48), snrDistribution(24), trafficByHourCategory(24),
    ]);
  } catch (e) {
    return <DbError error={e} />;
  }

  const noiseVals = noise.map((n) => Number(n.noise)).filter((v) => Number.isFinite(v));
  const latestNoise = noiseVals.length ? noiseVals[noiseVals.length - 1]! : null;
  const snrRows = SNR_LABELS.map((label, i) => ({ label, c: snr.find((s) => s.bkt === i)?.c ?? 0 }));

  const tiles = [
    { label: "Nodes seen (all time)", value: totals.nodes_seen },
    { label: "Heard (24h)", value: totals.heard_24h },
    { label: "Heard (7d)", value: totals.heard_7d },
    { label: "Gateways", value: totals.gateways },
    { label: "Packets (24h)", value: totals.packets_24h },
    { label: "Packets (7d)", value: totals.packets_7d },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <div key={t.label} className="card"><div className="stat-label">{t.label}</div><div className="stat mt-1 text-base">{fmtNum(t.value)}</div></div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="flex items-center justify-between"><h2 className="eyebrow"><span className="eyebrow-bar" />Packets per hour (48h)</h2><span className="text-[12px] text-ink-mute">last {fmtNum(Number(hourly[hourly.length - 1]?.total_packets ?? 0))}</span></div>
          <div className="mt-2"><Sparkline values={hourly.map((h) => Number(h.total_packets))} /></div>
        </div>
        <div className="card">
          <h2 className="eyebrow mb-2"><span className="eyebrow-bar" />Packets per day (30d)</h2>
          <Bars rows={daily.map((d) => ({ label: String(d.day).slice(0, 10), c: Number(d.packets) }))} color="bg-rx-relayed" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="eyebrow mb-2"><span className="eyebrow-bar" />Packet types (7d)</h2>
          <Bars rows={ptypes.map((p) => ({ label: portName(p.port_num), c: Number(p.c) }))} />
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <h2 className="eyebrow"><span className="eyebrow-bar" />RF noise floor (48h)</h2>
            <span className="text-[12px] text-ink-mute">{latestNoise == null ? "-" : `${Math.round(latestNoise)} dBm`}</span>
          </div>
          <p className="mt-1 text-[11px] text-ink-faint">Proxy: mesh-wide average RSSI minus SNR. Lower is a quieter band.</p>
          <div className="mt-2"><Sparkline values={noise.map((n) => Number(n.noise))} color="#e0b43a" /></div>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Traffic by type (24h)</h2>
        <StackedTraffic rows={traffic} />
      </div>

      <div className="card overflow-x-auto">
        <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Top talkers (24h)</h2>
        <table className="data">
          <thead><tr><th className="text-right">#</th><th>Node</th><th className="text-right">Packets</th><th className="text-right">Receptions</th></tr></thead>
          <tbody>
            {talkers.length === 0 && <tr><td colSpan={4} className="text-ink-faint">No traffic in the last 24h.</td></tr>}
            {talkers.map((t, i) => (
              <tr key={t.node_id}>
                <td className="text-right tabular-nums text-ink-faint">{i + 1}</td>
                <td><Link className="callsign" href={`/nodes/${t.node_id}`}>{t.long_name ?? formatNodeId(t.node_id)}</Link></td>
                <td className="text-right tabular-nums">{fmtNum(Number(t.packets))}</td>
                <td className="text-right tabular-nums text-ink-mute">{fmtNum(Number(t.receptions))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card overflow-x-auto">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Busiest RF links</h2>
          <table className="data">
            <thead><tr><th>Gateway</th><th>Node</th><th className="text-right">Receptions</th></tr></thead>
            <tbody>
              {links.length === 0 && <tr><td colSpan={3} className="text-ink-faint">No links yet.</td></tr>}
              {links.map((l) => (
                <tr key={`${l.gateway_id}-${l.node_id}`}>
                  <td className="mono text-ink-mute">{l.gw_name ?? formatNodeId(l.gateway_id)}</td>
                  <td><Link className="callsign" href={`/nodes/${l.node_id}`}>{l.node_name ?? formatNodeId(l.node_id)}</Link></td>
                  <td className="text-right tabular-nums">{fmtNum(Number(l.receptions))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card overflow-x-auto">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Busiest rooms / channels (24h)</h2>
          <table className="data">
            <thead><tr><th>Channel</th><th className="text-right">Packets</th><th className="text-right">Nodes</th><th className="text-right">Messages</th></tr></thead>
            <tbody>
              {rooms.length === 0 && <tr><td colSpan={4} className="text-ink-faint">No channel activity.</td></tr>}
              {rooms.map((c) => (
                <tr key={c.channel}>
                  <td className="mono"><Link className="callsign" href={`/messages?channel=${encodeURIComponent(c.channel)}`}>{c.channel}</Link></td>
                  <td className="text-right tabular-nums">{fmtNum(c.packets)}</td>
                  <td className="text-right tabular-nums">{fmtNum(c.nodes)}</td>
                  <td className="text-right tabular-nums">{fmtNum(c.messages)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2 className="eyebrow mb-2"><span className="eyebrow-bar" />SNR distribution (direct, 24h)</h2>
        <Bars rows={snrRows} color="bg-ok" />
      </div>
    </div>
  );
}
