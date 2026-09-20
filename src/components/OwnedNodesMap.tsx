"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildNodeElement, DARK_TILES, DARK_ATTRIB, roleColor } from "../lib/mapicons.ts";
import { cn } from "../lib/cn.ts";

export interface OwnedMapNode {
  id: number; name: string; node_id: string | null; role: string; owner_label: string | null;
  lat: number | null; lng: number | null; online: number; planned_site: number; open_issues: number;
}
interface TileConfig { url: string; attribution: string; darkUrl?: string; darkAttribution?: string }

const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

export function OwnedNodesMap({ nodes, tile }: { nodes: OwnedMapNode[]; tile: TileConfig }) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [dark, setDark] = useState(true);
  const [labels, setLabels] = useState(true);
  const persist = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* ignore */ } };

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem("hopwatch_map_dark") === "0") setDark(false);
    if (localStorage.getItem("hopwatch_map_labels") === "0") setLabels(false);
  }, []);

  const placed = nodes.filter((n) => n.lat != null && n.lng != null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const base = dark ? { url: tile.darkUrl ?? DARK_TILES, attribution: tile.darkAttribution ?? DARK_ATTRIB } : { url: tile.url, attribution: tile.attribution };
    const first = placed[0];
    const map = new maplibregl.Map({
      container: el,
      style: { version: 8, sources: { base: { type: "raster", tiles: [base.url], tileSize: 256, attribution: base.attribution } }, layers: [{ id: "base", type: "raster", source: "base" }] },
      center: first ? [first.lng!, first.lat!] : [0, 20],
      zoom: first ? 9 : 1.5,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const markers: maplibregl.Marker[] = [];
    const popup = new maplibregl.Popup({ closeButton: false, closeOnMove: true, offset: 18, className: "hw-popup" });
    const popBg = dark ? "#141412" : "#ffffff", popBorder = dark ? "#272725" : "#d4d4d4";
    const popText = dark ? "#f2f1ed" : "#0b0b0a", popFaint = dark ? "#8a8a84" : "#6f6e67";
    const row = (l: string, v: string) => `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:${popFaint}">${l}</span><span style="color:${popText}">${v}</span></div>`;

    map.on("load", () => {
      const lons: number[] = [], lats: number[] = [];
      for (const n of placed) {
        const isGw = /gateway/i.test(n.role);
        const elm = buildNodeElement({ name: n.name, role: n.role, isGateway: isGw, dark, showLabel: labels, estimated: !!n.planned_site });
        const html =
          `<div style="font:12px 'Segoe UI',system-ui;min-width:190px;background:${popBg};color:${popText};border:1px solid ${popBorder};border-radius:8px;padding:9px 11px;box-shadow:0 4px 14px rgba(0,0,0,.5)">` +
          `<div style="font-weight:700;font-size:13px">${esc(n.name)}</div>` +
          (n.node_id ? `<div style="color:${popFaint};font-family:monospace;font-size:11px;margin-bottom:6px">${esc(n.node_id)}</div>` : `<div style="margin-bottom:6px"></div>`) +
          `<div style="display:grid;gap:2px">` +
          row("Owner", esc(n.owner_label ?? "unclaimed")) +
          row("Role", esc(n.role)) +
          row("Status", n.online ? "online" : "offline") +
          (n.planned_site ? row("Planned", "yes") : "") +
          (n.open_issues > 0 ? row("Open issues", String(n.open_issues)) : "") +
          `</div></div>`;
        elm.addEventListener("mouseenter", () => popup.setLngLat([n.lng!, n.lat!]).setHTML(html).addTo(map));
        elm.addEventListener("mouseleave", () => popup.remove());
        elm.addEventListener("click", () => router.push("/owned-nodes"));
        markers.push(new maplibregl.Marker({ element: elm, anchor: "center" }).setLngLat([n.lng!, n.lat!]).addTo(map));
        lons.push(n.lng!); lats.push(n.lat!);
      }
      if (lons.length > 1) map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 48, duration: 0, maxZoom: 13 });
    });

    return () => { for (const mk of markers) mk.remove(); map.remove(); };
  }, [placed, tile, dark, labels, router]);

  const ctl = (active: boolean) => cn("rounded-md border px-3 py-1 text-[12px] font-medium shadow",
    dark ? "border-line-strong bg-surface text-ink" : "border-neutral-300 bg-white text-neutral-900", !active && "opacity-70");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => { const n = !dark; setDark(n); persist("hopwatch_map_dark", n); }} className={ctl(true)}>{dark ? "Dark map" : "Light map"}</button>
        <label className="flex items-center gap-1 text-[12px] text-ink-mute"><input type="checkbox" checked={labels} onChange={(e) => { setLabels(e.target.checked); persist("hopwatch_map_labels", e.target.checked); }} /> Node names</label>
        <span className="text-[11px] text-ink-faint">{placed.length} of {nodes.length} owned nodes have a position</span>
      </div>
      <div className="card flex flex-wrap items-center gap-x-5 gap-y-1 py-2 text-[11px] text-ink-mute">
        <span className="stat-label">Fill = role</span>
        {["Gateway", "Repeater", "Router", "Client"].map((r) => (
          <span key={r} className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full" style={{ background: roleColor(r === "Gateway" ? null : r.toUpperCase()) }} /> {r}</span>
        ))}
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full border border-dashed border-ink-faint" /> planned site (dashed)</span>
      </div>
      {placed.length === 0 ? (
        <div className="card text-ink-faint">No owned nodes have a position yet. Add lat/lng in the registry or claim positioned nodes.</div>
      ) : (
        <div ref={ref} className="h-[70vh] w-full overflow-hidden rounded-xl border border-line" />
      )}
    </div>
  );
}
