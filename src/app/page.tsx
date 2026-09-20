import { moduleDenied } from "../components/ModuleGate.tsx";
import { getDashboard, getHealthSnapshot, meshTrends, pkiAdoption, getTextStats, type MeshTrendPoint, type TextStats } from "../db/queries.ts";
import Link from "next/link";
import { fmtNum, fmtAge } from "../lib/format.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { effectiveConfig } from "../db/appsettings.ts";

// UTC instant of the start of "today" in the given IANA zone (uses the current offset).
function localDayStartUtc(zone: string): Date {
  const now = new Date();
  try {
    const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-").map(Number);
    const utcNow = new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    const locNow = new Date(now.toLocaleString("en-US", { timeZone: zone })).getTime();
    return new Date(Date.UTC(y!, m! - 1, d!, 0, 0, 0) - (locNow - utcNow));
  } catch {
    return new Date(now.getTime() - 24 * 3600 * 1000);
  }
}
import { networkCondition, conditionTextClass } from "../lib/condition.ts";
import { cn } from "../lib/cn.ts";
import { DbError } from "../components/DbError.tsx";
import { LiveFeed } from "../components/LiveFeed.tsx";
import { LiveMessages } from "../components/LiveMessages.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat mt-1">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}

function Sparkline({ values, color = "#3f9e63" }: { values: number[]; color?: string }) {
  const W = 240, H = 36;
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return <div className="flex h-9 items-center text-[11px] text-ink-faint">not enough data</div>;
  const min = Math.min(...clean), max = Math.max(...clean), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - ((Number.isFinite(v) ? v : min) - min) / span * H}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 36 }} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function TrendCard({ label, values, latest, color }: { label: string; values: number[]; latest: string; color?: string }) {
  return (
    <div className="card">
      <div className="flex items-baseline justify-between">
        <div className="stat-label">{label}</div>
        <div className="text-sm font-semibold tabular-nums text-ink">{latest}</div>
      </div>
      <div className="mt-2"><Sparkline values={values} color={color} /></div>
    </div>
  );
}

export default async function DashboardPage() {
  const __denied = await moduleDenied("dashboard"); if (__denied) return __denied;
  let zone = "UTC";
  try { zone = (await effectiveConfig()).server.local_timezone; } catch { /* default UTC */ }
  let data, health, trends: MeshTrendPoint[] = [], pki = { total: 0, with_key: 0 };
  let texts: TextStats = { total: 0, topSenders: [], byBroker: [] };
  try {
    [data, health, trends, pki, texts] = await Promise.all([getDashboard(), getHealthSnapshot(), meshTrends(48), pkiAdoption(), getTextStats(localDayStartUtc(zone), 10)]);
  } catch (e) {
    return <DbError error={e} />;
  }
  const pkiPct = pki.total > 0 ? Math.round((pki.with_key / pki.total) * 100) : 0;
  const senderMax = Math.max(1, ...texts.topSenders.map((s) => Number(s.c)));
  const brokerMax = Math.max(1, ...texts.byBroker.map((b) => Number(b.c)));

  return (
    <div className="flex h-full min-h-[calc(100vh-9rem)] flex-col gap-6">
      {health?.score != null && (
        <div className="card">
          <div className="flex items-center justify-between">
            <h2 className="eyebrow">
              <span className="eyebrow-bar" />
              Mesh health
            </h2>
            <div className="flex items-baseline gap-3">
              {(() => {
                const ageMin = health.computed_at ? (Date.now() - new Date(health.computed_at.replace(" ", "T") + "Z").getTime()) / 60000 : null;
                const cond = networkCondition(health.score, ageMin);
                return <span className={cn("text-sm font-semibold uppercase tracking-wide", conditionTextClass(cond.tone))}>{cond.label}</span>;
              })()}
              <span className={cn("stat", health.score >= 70 ? "text-ok" : health.score >= 40 ? "text-gold-ink" : "text-accent-strong")}>
                {health.score}
                <span className="ml-1 text-[13px] text-ink-faint">/ 100</span>
              </span>
            </div>
          </div>
          {health.breakdown?.inputs && (
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-5">
              {Object.entries(health.breakdown.inputs as Record<string, number>).map(([k, v]) => (
                <div key={k}>
                  <div className="flex justify-between text-[11px] text-ink-faint">
                    <span>{k.replace(/_/g, " ")}</span>
                    <span>{Math.round(v * 100)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded bg-raised">
                    <div className="h-1.5 rounded bg-ok" style={{ width: `${Math.round(v * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Active nodes (24h)" value={fmtNum(data.activeNodes24h)} />
        <StatTile label="Known nodes" value={fmtNum(data.totalNodes)} />
        <StatTile label="Gateways" value={fmtNum(data.gateways)} />
        <StatTile label="Direct pairs" value={fmtNum(data.directPairs)} />
        <StatTile label="Receptions (24h)" value={fmtNum(data.receptions24h)} />
        <StatTile label="Packets (24h)" value={fmtNum(data.packets24h)} />
      </div>

      {trends.length >= 2 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <TrendCard label="Active nodes (48h)" values={trends.map((t) => Number(t.active_nodes))} latest={fmtNum(Number(trends[trends.length - 1]!.active_nodes))} />
          <TrendCard label="Channel util % (48h)" color="#e0b43a" values={trends.map((t) => Number(t.avg_chan_util ?? 0))} latest={`${(Number(trends[trends.length - 1]!.avg_chan_util ?? 0)).toFixed(1)}%`} />
          <TrendCard label="Packets/hr (48h)" color="#5bb37e" values={trends.map((t) => Number(t.total_packets))} latest={fmtNum(Number(trends[trends.length - 1]!.total_packets))} />
          <div className="card">
            <div className="flex items-baseline justify-between">
              <div className="stat-label">Encryption (public key)</div>
              <div className="text-sm font-semibold tabular-nums text-ink">{pkiPct}%</div>
            </div>
            <div className="stat mt-1">{fmtNum(pki.with_key)}<span className="ml-1 text-[13px] text-ink-faint">/ {fmtNum(pki.total)}</span></div>
            <div className="mt-1 text-[11px] text-ink-faint">nodes advertising a public key</div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="flex items-baseline justify-between">
          <h2 className="eyebrow"><span className="eyebrow-bar" />Text messages today</h2>
          <div className="flex items-baseline gap-2"><span className="stat">{fmtNum(texts.total)}</span><span className="text-[11px] text-ink-faint">total ({zone})</span></div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-2">
          <div>
            <div className="stat-label mb-2">Top texters</div>
            {texts.topSenders.length === 0 ? (
              <p className="text-[13px] text-ink-faint">No text messages yet today.</p>
            ) : texts.topSenders.map((s) => (
              <div key={s.node_id} className="flex items-center gap-2 text-[13px]">
                <Link className="callsign w-36 shrink-0 truncate" href={`/nodes/${s.node_id}`} title={s.name ?? formatNodeId(s.node_id)}>{s.name ?? formatNodeId(s.node_id)}</Link>
                {s.short_name && <span className="mono w-10 shrink-0 text-[11px] text-ink-faint">{s.short_name}</span>}
                <div className="h-2.5 flex-1 rounded bg-raised"><div className="h-2.5 rounded bg-rx-direct" style={{ width: `${Math.round((Number(s.c) / senderMax) * 100)}%` }} /></div>
                <span className="w-10 shrink-0 text-right tabular-nums">{fmtNum(Number(s.c))}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="stat-label mb-2">By broker</div>
            {texts.byBroker.length === 0 ? (
              <p className="text-[13px] text-ink-faint">No text messages yet today.</p>
            ) : texts.byBroker.map((b) => (
              <div key={b.broker} className="flex items-center gap-2 text-[13px]">
                <span className="mono w-36 shrink-0 truncate text-ink-mute" title={b.broker}>{b.broker}</span>
                <div className="h-2.5 flex-1 rounded bg-raised"><div className="h-2.5 rounded bg-rx-relayed" style={{ width: `${Math.round((Number(b.c) / brokerMax) * 100)}%` }} /></div>
                <span className="w-10 shrink-0 text-right tabular-nums">{fmtNum(Number(b.c))}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-2">
        <LiveFeed />

        <div className="flex min-h-0 flex-col gap-6">
        <div className="card">
          <h2 className="eyebrow mb-3">
            <span className="eyebrow-bar" />
            Broker health
          </h2>
          {data.brokers.length === 0 ? (
            <p className="text-[13px] text-ink-faint">
              No broker has reported yet. Start the ingest daemon with <span className="mono">npm run ingest</span>.
            </p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Broker</th>
                  <th>State</th>
                  <th>Last msg</th>
                  <th className="text-right">Messages</th>
                  <th className="text-right">Malformed</th>
                </tr>
              </thead>
              <tbody>
                {data.brokers.map((b) => (
                  <tr key={b.broker_id}>
                    <td className="mono">{b.broker_id}</td>
                    <td>
                      <span className={cn("pill", b.connected ? "pill-on" : "pill-off")}>
                        {b.connected ? "connected" : "down"}
                      </span>
                    </td>
                    <td className="text-ink-mute">{fmtAge(b.last_message_at)}</td>
                    <td className="text-right tabular-nums">{fmtNum(b.messages)}</td>
                    <td className="text-right tabular-nums text-rx-relayed">{fmtNum(b.malformed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <LiveMessages />
        </div>
      </div>
    </div>
  );
}
