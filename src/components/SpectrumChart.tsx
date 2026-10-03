"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { portName } from "../meshtastic/portnum.ts";
import { cn } from "../lib/cn.ts";
import { fmtNum } from "../lib/format.ts";

export interface SpectrumRow { bucket: string; port_num: number; direct: number; relayed: number }
export interface SpectrumStats { direct: number; relayed: number; receptions: number; unique: number; dupe_pct: number; mean_snr: number | null; errors: number }

// Categorical palette assigned to ports in descending-volume order (busiest port gets the first
// color), so the legend reads top-down like the reference dashboard.
const PALETTE = [
  "#7c6cf0", "#2bb8c4", "#3b82f6", "#eab308", "#22c55e", "#14b8a6",
  "#f97316", "#a16207", "#ec4899", "#ef4444", "#a855f7", "#84cc16",
];
const WINDOWS: [string, number][] = [["12h", 12], ["24h", 24], ["3d", 72], ["7d", 168]];
const BINS: [string, number][] = [["10m", 10], ["15m", 15], ["30m", 30], ["1h", 60]];

const shortPort = (p: number) => (p === 0 ? "OTHER" : portName(p).replace(/_APP$/, "").replace(/_PLUSPLUS/, "++").replace(/_/g, " "));
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const parseBucket = (b: string) => new Date(b.replace(" ", "T") + "Z");
const tLabel = (b?: string) => (b ? parseBucket(b).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "");
const tLabelFull = (b?: string) => (b ? parseBucket(b).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

export function SpectrumChart({ rows, stats, hours, bin, compact = false }: { rows: SpectrumRow[]; stats: SpectrumStats; hours: number; bin: number; compact?: boolean }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ idx: number; px: number; py: number; w: number } | null>(null);

  // Ordered buckets + per-bucket per-port map.
  const bucketList = Array.from(new Set(rows.map((r) => r.bucket)));
  const byBucket = new Map<string, Map<number, { direct: number; relayed: number }>>();
  const portTotals = new Map<number, { direct: number; relayed: number }>();
  for (const r of rows) {
    if (!byBucket.has(r.bucket)) byBucket.set(r.bucket, new Map());
    byBucket.get(r.bucket)!.set(r.port_num, { direct: Number(r.direct), relayed: Number(r.relayed) });
    const t = portTotals.get(r.port_num) ?? { direct: 0, relayed: 0 };
    t.direct += Number(r.direct); t.relayed += Number(r.relayed);
    portTotals.set(r.port_num, t);
  }
  const ports = Array.from(portTotals.entries())
    .sort((a, b) => (b[1].direct + b[1].relayed) - (a[1].direct + a[1].relayed))
    .map(([port], i) => ({ port, color: PALETTE[i % PALETTE.length]! }));

  let maxHalf = 1;
  for (const m of byBucket.values()) {
    let up = 0, dn = 0;
    for (const v of m.values()) { up += v.direct; dn += v.relayed; }
    maxHalf = Math.max(maxHalf, up, dn);
  }

  const H = 340, CY = 170, HALF = 150, COL = 14;
  const n = Math.max(bucketList.length, 1);
  const W = n * COL;

  const go = (h: number, b: number) => router.push(`/spectrum?hours=${h}&bin=${b}`);
  const btn = (active: boolean) => cn("rounded-md border px-2.5 py-1 text-[12px]", active ? "border-accent bg-accent/10 text-ink" : "border-line text-ink-mute hover:text-ink");

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(rel * n)));
    setHover({ idx, px: e.clientX - rect.left, py: e.clientY - rect.top, w: rect.width });
  };

  // Hovered bucket breakdown (ports sorted by volume in that bucket).
  const hb = hover && bucketList[hover.idx] ? byBucket.get(bucketList[hover.idx]!) : null;
  const hoverPorts = hb ? ports.map((p) => ({ ...p, ...(hb.get(p.port) ?? { direct: 0, relayed: 0 }) })).filter((p) => p.direct || p.relayed) : [];
  const hoverUp = hoverPorts.reduce((s, p) => s + p.direct, 0);
  const hoverDn = hoverPorts.reduce((s, p) => s + p.relayed, 0);

  return (
    <div className={compact ? "space-y-2" : "space-y-4"}>
      {compact ? (
        <div className="flex items-baseline justify-between">
          <Link href="/spectrum" className="stat-label hover:text-ink">Traffic spectrum &rsaquo;</Link>
          <div className="text-[12px] tabular-nums text-ink-mute">
            <span className="text-emerald-400">&#9650;{fmtNum(stats.direct)}</span> direct &nbsp;
            <span className="text-red-400">&#9660;{fmtNum(stats.relayed)}</span> relayed
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <Stat value={fmt(stats.direct)} label="Direct" up />
            <Stat value={fmt(stats.relayed)} label="Relayed" />
            <Stat value={`${stats.dupe_pct.toFixed(0)}%`} label="Dupe" />
            <Stat value={stats.mean_snr == null ? "-" : `${stats.mean_snr.toFixed(1)}`} label="Mean SNR dB" />
            <span className={cn("rounded-md border px-2 py-1 text-[12px]", stats.errors > 0 ? "border-danger/50 text-danger" : "border-line text-ink-faint")}>errors {stats.errors}</span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
            <div className="flex items-center gap-1"><span className="stat-label mr-1">Window</span>{WINDOWS.map(([l, h]) => <button key={h} className={btn(hours === h)} onClick={() => go(h, bin)}>{l}</button>)}</div>
            <div className="flex items-center gap-1"><span className="stat-label mr-1">Bucket</span>{BINS.map(([l, b]) => <button key={b} className={btn(bin === b)} onClick={() => go(hours, b)}>{l}</button>)}</div>
          </div>
        </>
      )}

      {bucketList.length === 0 ? (
        <div className="card text-ink-faint">No RF receptions in this window yet.</div>
      ) : (
        <>
          <div ref={ref} className="relative overflow-hidden rounded-xl border border-line" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("block w-full", compact ? "h-[150px]" : "h-[360px]")}>
              <rect x={0} y={0} width={W} height={CY} fill="#3b82f6" opacity={0.06} />
              <rect x={0} y={CY} width={W} height={H - CY} fill="#ef4444" opacity={0.06} />
              <line x1={0} y1={CY} x2={W} y2={CY} stroke="currentColor" strokeOpacity={0.25} strokeWidth={0.5} className="text-ink-faint" />
              {bucketList.map((b, i) => {
                const m = byBucket.get(b)!;
                const x = i * COL;
                let up = CY, dn = CY;
                const segs: React.ReactNode[] = [];
                for (const { port, color } of ports) {
                  const v = m.get(port);
                  if (!v) continue;
                  if (v.direct > 0) { const h = (v.direct / maxHalf) * HALF; segs.push(<rect key={`u${port}`} x={x} y={up - h} width={COL - 1.5} height={h} fill={color} />); up -= h; }
                  if (v.relayed > 0) { const h = (v.relayed / maxHalf) * HALF; segs.push(<rect key={`d${port}`} x={x} y={dn} width={COL - 1.5} height={h} fill={color} opacity={0.72} />); dn += h; }
                }
                return <g key={b}>{segs}</g>;
              })}
            </svg>
            {/* Crosshair */}
            {hover && (
              <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-ink/40" style={{ left: `${((hover.idx + 0.5) / n) * 100}%` }} />
            )}
            {/* Tooltip */}
            {hover && hoverPorts.length > 0 && (
              <div
                className="pointer-events-none absolute z-10 min-w-[160px] rounded-lg border border-line bg-surface/95 p-2 text-[11px] shadow-lg backdrop-blur"
                style={{ left: hover.px > hover.w - 190 ? hover.px - 178 : hover.px + 12, top: Math.min(hover.py, 200) }}
              >
                <div className="mb-1 font-medium text-ink">{tLabelFull(bucketList[hover.idx])}</div>
                <div className="mb-1 text-ink-faint"><span className="text-emerald-400">&#9650;{hoverUp} direct</span> &nbsp; <span className="text-red-400">&#9660;{hoverDn} relayed</span></div>
                {hoverPorts.slice(0, 8).map((p) => (
                  <div key={p.port} className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: p.color }} />
                    <span className="truncate text-ink-mute">{shortPort(p.port)}</span>
                    <span className="ml-auto tabular-nums"><span className="text-emerald-400">{p.direct}</span>/<span className="text-red-400">{p.relayed}</span></span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {!compact && (
            <>
              <div className="flex justify-between text-[11px] text-ink-faint">
                <span>{tLabel(bucketList[0])}</span>
                <span>{tLabel(bucketList[Math.floor(bucketList.length / 2)])}</span>
                <span>{tLabel(bucketList[bucketList.length - 1])}</span>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-ink-mute">
                <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: "#3b82f6", opacity: 0.5 }} />up = direct (0 hop)</span>
                <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: "#ef4444", opacity: 0.5 }} />down = relayed</span>
                <span className="text-ink-faint">hover across for per-bucket detail</span>
              </div>

              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-3 lg:grid-cols-4">
                {ports.map(({ port, color }) => {
                  const t = portTotals.get(port)!;
                  return (
                    <div key={port} className="flex items-center gap-2 text-ink-mute">
                      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                      <span className="truncate text-ink">{shortPort(port)}</span>
                      <span className="ml-auto tabular-nums text-[11px]"><span className="text-emerald-400">&#9650;{fmt(t.direct)}</span> <span className="text-red-400">&#9660;{fmt(t.relayed)}</span></span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ value, label, up }: { value: string; label: string; up?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-3xl font-semibold tabular-nums text-ink">{value}</span>
      <span className={cn("rounded-md border border-line px-1.5 py-0.5 text-[11px]", up ? "text-emerald-400" : "text-ink-faint")}>{label}</span>
    </div>
  );
}
