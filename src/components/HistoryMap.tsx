"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { formatNodeId } from "../meshtastic/types.ts";
import { buildNodeElement, DARK_TILES, DARK_ATTRIB } from "../lib/mapicons.ts";
import { MapLegend } from "./MapLegend.tsx";
import { cn } from "../lib/cn.ts";

interface HNode {
  node_id: number; long_name: string | null; short_name: string | null; role: string | null;
  is_gateway: number; latitude: number; longitude: number; altitude_m: number | null; hops: number | null;
}
interface TileConfig { url: string; attribution: string; darkUrl?: string; darkAttribution?: string }

const WINDOWS = [
  { label: "15 min", min: 15 }, { label: "1 hour", min: 60 }, { label: "6 hours", min: 360 }, { label: "24 hours", min: 1440 },
];
const STEP_MS = 15 * 60 * 1000; // slider granularity: 15 minutes
const SPAN_MS = 7 * 24 * 3600 * 1000; // scrub across the last 7 days
const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

export function HistoryMap({ tile, now, tz }: { tile: TileConfig; now: number; tz: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const fittedRef = useRef(false);
  const [dark, setDark] = useState(true);
  const [labels, setLabels] = useState(true);
  const [shortNames, setShortNames] = useState(false);
  const [windowMin, setWindowMin] = useState(60);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(0);

  // Slider domain: [now - 7d, now], stepped by 15 min. Value is the selected instant (ms).
  const min = now - SPAN_MS;
  const steps = Math.floor(SPAN_MS / STEP_MS);
  const [at, setAt] = useState(now);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem("hopwatch_map_dark") === "0") setDark(false);
    if (localStorage.getItem("hopwatch_map_labels") === "0") setLabels(false);
    if (localStorage.getItem("hopwatch_map_shortnames") === "1") setShortNames(true);
  }, []);

  // Build the base map once (re-create on theme change).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const base = dark ? { url: tile.darkUrl ?? DARK_TILES, attribution: tile.darkAttribution ?? DARK_ATTRIB } : { url: tile.url, attribution: tile.attribution };
    const map = new maplibregl.Map({
      container: el,
      style: { version: 8, sources: { base: { type: "raster", tiles: [base.url], tileSize: 256, attribution: base.attribution } }, layers: [{ id: "base", type: "raster", source: "base" }] },
      center: [0, 20], zoom: 1.6, attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    fittedRef.current = false;
    return () => { map.remove(); mapRef.current = null; };
  }, [dark, tile]);

  const render = useCallback((nodes: HNode[]) => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    const popup = new maplibregl.Popup({ closeButton: false, closeOnMove: true, offset: 16, className: "hw-popup" });
    const lons: number[] = [], lats: number[] = [];
    for (const n of nodes) {
      const name = shortNames ? (n.short_name ?? n.long_name ?? formatNodeId(n.node_id)) : (n.long_name ?? n.short_name ?? formatNodeId(n.node_id));
      const elm = buildNodeElement({ name, role: n.role, isGateway: !!n.is_gateway, hops: n.hops, dark, showLabel: labels });
      const html = `<div style="font:12px 'Segoe UI',system-ui;padding:2px"><b>${esc(name)}</b><br><span style="opacity:.7;font-family:monospace">${formatNodeId(n.node_id)}</span></div>`;
      elm.addEventListener("mouseenter", () => popup.setLngLat([n.longitude, n.latitude]).setHTML(html).addTo(map));
      elm.addEventListener("mouseleave", () => popup.remove());
      elm.addEventListener("click", () => router.push(`/nodes/${n.node_id}`));
      markersRef.current.push(new maplibregl.Marker({ element: elm, anchor: "center" }).setLngLat([n.longitude, n.latitude]).addTo(map));
      lons.push(n.longitude); lats.push(n.latitude);
    }
    setCount(nodes.length);
    // Fit to the data once, so subsequent scrubbing keeps the viewport steady.
    if (lons.length > 1 && !fittedRef.current) {
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 48, duration: 0, maxZoom: 12 });
      fittedRef.current = true;
    }
  }, [dark, labels, shortNames, router]);

  // Fetch + render whenever the instant or window changes (debounced for smooth scrubbing).
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/v1/history?at=${at}&window=${windowMin}`);
        if (!r.ok || cancelled) return;
        const d = await r.json();
        if (!cancelled) render(d.nodes ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [at, windowMin, render]);

  // Playback: advance the instant one step per tick; stop at the end.
  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      setAt((prev) => {
        const next = prev + STEP_MS;
        if (next >= now) { setPlaying(false); return now; }
        return next;
      });
    }, 900);
    return () => clearInterval(iv);
  }, [playing, now]);

  const stamp = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
  const ctl = (active: boolean) => cn("rounded-md border px-3 py-1 text-[12px] font-medium shadow", dark ? "border-line-strong bg-surface text-ink" : "border-neutral-300 bg-white text-neutral-900", !active && "opacity-70");
  const sel = "h-8 rounded-md border border-line bg-raised px-2 text-[12px] text-ink";
  const atEnd = at >= now - STEP_MS;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => { const n = !dark; setDark(n); try { localStorage.setItem("hopwatch_map_dark", n ? "1" : "0"); } catch { /* ignore */ } }} className={ctl(true)}>{dark ? "Dark map" : "Light map"}</button>
        <label className="flex items-center gap-1 text-[12px] text-ink-mute"><input type="checkbox" checked={labels} onChange={(e) => { setLabels(e.target.checked); try { localStorage.setItem("hopwatch_map_labels", e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} /> Names</label>
        <label className="flex items-center gap-1 text-[12px] text-ink-mute"><input type="checkbox" checked={shortNames} onChange={(e) => { setShortNames(e.target.checked); try { localStorage.setItem("hopwatch_map_shortnames", e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} /> Short names</label>
        <label className="flex items-center gap-1 text-[12px] text-ink-mute">window
          <select className={sel} value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))}>
            {WINDOWS.map((w) => <option key={w.min} value={w.min}>{w.label}</option>)}
          </select>
        </label>
        <span className="text-[11px] text-ink-faint">{count} nodes active {loading ? "· loading..." : ""}</span>
      </div>

      <div className="card flex flex-wrap items-center gap-3 py-2">
        <button className="btn btn-primary h-8 w-16 px-3 text-[13px]" onClick={() => { if (atEnd) setAt(min); setPlaying((p) => !p); }}>{playing ? "Pause" : "Play"}</button>
        <button className="btn btn-outline h-8 px-3 text-[12px]" onClick={() => { setPlaying(false); setAt(now); }}>Now</button>
        <input
          type="range" min={0} max={steps} value={Math.round((at - min) / STEP_MS)}
          onChange={(e) => { setPlaying(false); setAt(min + Number(e.target.value) * STEP_MS); }}
          className="h-2 min-w-[240px] flex-1 accent-[var(--accent,#3f9e63)]"
        />
        <span className="mono w-32 text-right text-[13px] text-ink">{stamp}{atEnd ? " (now)" : ""}</span>
      </div>

      <MapLegend />
      <div ref={ref} className="h-[68vh] w-full overflow-hidden rounded-xl border border-line" />
      <p className="text-[11px] text-ink-faint">Shows nodes that transmitted within the chosen window before the selected time, at the last position they reported by then. Scrub or press Play to watch the network evolve over the last 7 days.</p>
    </div>
  );
}
