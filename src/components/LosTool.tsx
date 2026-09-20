"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { formatNodeId } from "../meshtastic/types.ts";

interface Opt { node_id: number; name: string | null }
interface Sample { d_km: number; ground_m: number; los_m: number; fresnel_bottom_m: number }
interface Los {
  distance_km: number; fspl_db: number; fresnel_max_m: number; has_terrain: boolean;
  clearance_m: number | null; obstructed: boolean; a_ground_m: number | null; b_ground_m: number | null; samples: Sample[];
}
interface Result { a: { node_id: number; name: string | null; antenna_m: number }; b: { node_id: number; name: string | null; antenna_m: number }; los: Los }

const sel = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

function CrossSection({ samples }: { samples: Sample[] }) {
  const W = 760, H = 280, pad = 32;
  const xs = samples.map((s) => s.d_km);
  const ys = samples.flatMap((s) => [s.ground_m, s.los_m, s.fresnel_bottom_m]);
  const xMax = Math.max(...xs, 0.001);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const yRange = yMax - yMin || 1;
  const px = (d: number) => pad + (d / xMax) * (W - 2 * pad);
  const py = (m: number) => H - pad - ((m - yMin) / yRange) * (H - 2 * pad);
  const ground = samples.map((s) => `${px(s.d_km)},${py(s.ground_m)}`).join(" ");
  const groundArea = `${pad},${H - pad} ${ground} ${W - pad},${H - pad}`;
  const los = samples.map((s) => `${px(s.d_km)},${py(s.los_m)}`).join(" ");
  const fresnel = samples.map((s) => `${px(s.d_km)},${py(s.fresnel_bottom_m)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <polygon points={groundArea} fill="var(--color-raised)" stroke="var(--color-line-strong)" strokeWidth={1} />
      <polyline points={fresnel} fill="none" stroke="var(--color-gold)" strokeWidth={1} strokeDasharray="4 3" />
      <polyline points={los} fill="none" stroke="var(--color-accent-strong)" strokeWidth={1.5} />
      <text x={pad} y={H - 8} fill="var(--color-ink-faint)" fontSize={10}>0 km</text>
      <text x={W - pad - 32} y={H - 8} fill="var(--color-ink-faint)" fontSize={10}>{xMax.toFixed(1)} km</text>
    </svg>
  );
}

export function LosTool({ nodes, initialA, initialB }: { nodes: Opt[]; initialA?: number; initialB?: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const [a, setA] = useState<string>(initialA ? String(initialA) : "");
  const [b, setB] = useState<string>(initialB ? String(initialB) : "");
  const [res, setRes] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = useCallback(async (aId: string, bId: string) => {
    if (!aId || !bId || aId === bId) { setRes(null); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/v1/los?a=${aId}&b=${bId}`);
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? "failed"); setRes(null); }
      else setRes(d);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  // Reflect the current pair in the address bar so it is shareable and survives reload/back.
  // replace() (not push) keeps one selection from flooding history.
  const syncUrl = useCallback((aId: string, bId: string) => {
    const qs = new URLSearchParams();
    if (aId) qs.set("a", aId);
    if (bId) qs.set("b", bId);
    const q = qs.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }, [router, pathname]);

  // Set one endpoint, recompute, and update the URL.
  const pick = useCallback((which: "a" | "b", value: string) => {
    setCopied(false);
    if (which === "a") { setA(value); syncUrl(value, b); run(value, b); }
    else { setB(value); syncUrl(a, value); run(a, value); }
  }, [a, b, run, syncUrl]);

  async function copyLink() {
    try {
      const url = `${window.location.origin}${pathname}?a=${a}&b=${b}`;
      await navigator.clipboard.writeText(url);
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  useEffect(() => { if (a && b) run(a, b); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const label = (o: Opt) => o.name ?? formatNodeId(o.node_id);
  const los = res?.los;
  const clearance = los?.clearance_m;

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-3">
        <label className="space-y-1"><span className="block stat-label">From node</span>
          <select className={`${sel} w-56`} value={a} onChange={(e) => pick("a", e.target.value)}>
            <option value="">select...</option>
            {nodes.map((o) => <option key={o.node_id} value={o.node_id}>{label(o)}</option>)}
          </select>
        </label>
        <label className="space-y-1"><span className="block stat-label">To node</span>
          <select className={`${sel} w-56`} value={b} onChange={(e) => pick("b", e.target.value)}>
            <option value="">select...</option>
            {nodes.map((o) => <option key={o.node_id} value={o.node_id}>{label(o)}</option>)}
          </select>
        </label>
        {a && b && a !== b && (
          <button type="button" className="btn btn-outline h-9 px-3 text-[13px]" onClick={copyLink} title="Copy a shareable link to this pair">
            {copied ? "Link copied" : "Copy link"}
          </button>
        )}
        {loading && <span className="text-[12px] text-ink-faint">computing...</span>}
        {error && <span className="text-[12px] text-accent-strong">{error}</span>}
      </div>

      {los && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="card"><div className="stat-label">Distance</div><div className="stat mt-1 text-base">{los.distance_km.toFixed(2)} km</div></div>
            <div className="card"><div className="stat-label">Free-space loss</div><div className="stat mt-1 text-base">{los.fspl_db.toFixed(0)} dB</div></div>
            <div className="card"><div className="stat-label">Fresnel radius</div><div className="stat mt-1 text-base">{los.fresnel_max_m.toFixed(0)} m</div></div>
            <div className="card">
              <div className="stat-label">Line of sight</div>
              <div className={`stat mt-1 text-base ${!los.has_terrain ? "text-ink-faint" : los.obstructed ? "text-accent-strong" : "text-ok"}`}>
                {!los.has_terrain ? "no terrain" : los.obstructed ? "obstructed" : "clear"}
              </div>
            </div>
          </div>

          <div className="card">
            <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Terrain cross-section</h2>
            {los.has_terrain && los.samples.length > 1 ? (
              <>
                <CrossSection samples={los.samples} />
                <p className="mt-2 text-[11px] text-ink-faint">
                  Grey = terrain, red = line of sight between antenna tops ({res!.a.antenna_m} m / {res!.b.antenna_m} m AGL),
                  dashed gold = bottom of the first Fresnel zone. Worst clearance {clearance == null ? "-" : `${clearance.toFixed(0)} m`}
                  {clearance != null && clearance < 0 ? " (terrain blocks the path)" : clearance != null ? " (clear)" : ""}.
                </p>
              </>
            ) : (
              <p className="text-[13px] text-ink-faint">
                No elevation profile. Set an elevation source under <span className="mono">/admin/settings</span> (RF &amp; propagation, link budget) to enable the terrain cross-section; the distance and free-space figures above still apply.
              </p>
            )}
          </div>
        </>
      )}
      {!los && !loading && <div className="card text-ink-faint">Pick two positioned nodes to check line of sight and the terrain profile between them.</div>}
    </div>
  );
}
