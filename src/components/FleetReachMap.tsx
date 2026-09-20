"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export interface FleetNode { id: number; name: string | null; lat: number | null; lon: number | null; role: string | null; mine: boolean }
export interface FleetEdge { a: number; b: number; type: "direct" | "neighbor"; snr: number | null }
export interface FleetRelay { id: number; name: string | null; lat: number | null; lon: number | null; count: number; links: number[] }

// One map of all a user's claimed nodes plus everyone that hears them / they hear, MeshSense-style.
// My nodes are drawn large and violet; everyone else small and gray; edges colored by link type
// (direct green, neighbor blue). An optional relayed-by layer (amber dashed) shows gateways that hear
// the fleet only via a relay. Re-inits when `stamp` changes so a page refresh redraws fresh data.
export function FleetReachMap({ nodes, edges, relayers = [], tile, stamp }: {
  nodes: FleetNode[];
  edges: FleetEdge[];
  relayers?: FleetRelay[];
  tile: { url: string; attribution: string; darkUrl?: string; darkAttribution?: string };
  stamp: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dark, setDark] = useState(true);
  const [showRelay, setShowRelay] = useState(false);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const mappable = nodes.filter((n) => n.lat != null && n.lon != null) as (FleetNode & { lat: number; lon: number })[];
  const relPos = relayers.filter((r) => r.lat != null && r.lon != null) as (FleetRelay & { lat: number; lon: number })[];
  const hasAny = mappable.length > 0;
  // Fall back to the canonical !hex node id when a distant node has no NodeInfo (no long/short name yet).
  const fmtId = (n: { id: number; name: string | null }) => n.name ?? "!" + (n.id >>> 0).toString(16).padStart(8, "0");
  // Label the surrounding nodes too, unless the map is so dense the labels would be a hairball.
  const labelOthers = mappable.length <= 90;

  useEffect(() => {
    if (!wrapRef.current || !hasAny) return;
    const url = dark ? tile.darkUrl ?? tile.url : tile.url;
    const attribution = (dark ? tile.darkAttribution ?? tile.attribution : tile.attribution) || "";
    const first = mappable[0]!;
    const map = new maplibregl.Map({
      container: wrapRef.current,
      style: { version: 8, sources: { base: { type: "raster", tiles: [url], tileSize: 256, attribution } }, layers: [{ id: "base", type: "raster", source: "base" }] },
      center: [first.lon, first.lat], zoom: 8, attributionControl: { compact: true },
    });

    map.on("load", () => {
      const feats = edges
        .map((e) => { const a = byId.get(e.a), b = byId.get(e.b); return a && b && a.lat != null && b.lat != null ? { a, b, e } : null; })
        .filter((x): x is { a: FleetNode & { lat: number; lon: number }; b: FleetNode & { lat: number; lon: number }; e: FleetEdge } => !!x)
        .map(({ a, b, e }) => ({ type: "Feature" as const, properties: { color: e.type === "direct" ? "#3f9e63" : "#60a5fa" }, geometry: { type: "LineString" as const, coordinates: [[a.lon, a.lat], [b.lon, b.lat]] } }));
      map.addSource("edges", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
      map.addLayer({ id: "edges", type: "line", source: "edges", paint: { "line-color": ["get", "color"], "line-width": 1.2, "line-opacity": 0.5 } });

      // Relayed-by layer (optional, under the direct/neighbor edges): amber dashed lines from each fleet
      // node to the gateways that carry it via a relay, plus hollow amber markers for those gateways.
      if (showRelay && relPos.length) {
        const relFeats = relPos.flatMap((r) =>
          r.links.map((mid) => byId.get(mid)).filter((m): m is FleetNode & { lat: number; lon: number } => !!m && m.lat != null && m.lon != null)
            .map((m) => ({ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: [[m.lon, m.lat], [r.lon, r.lat]] } })));
        map.addSource("relay-lines", { type: "geojson", data: { type: "FeatureCollection", features: relFeats } });
        map.addLayer({ id: "relay-lines", type: "line", source: "relay-lines", paint: { "line-color": "#e0b43a", "line-width": 1, "line-opacity": 0.35, "line-dasharray": [2, 2] } }, "edges");
        for (const r of relPos) {
          const wrap = document.createElement("div");
          wrap.style.cssText = "display:flex;flex-direction:column;align-items:center";
          const dot = document.createElement("div");
          dot.style.cssText = "width:9px;height:9px;border-radius:50%;background:transparent;border:1.5px solid #e0b43a;box-shadow:0 1px 2px rgba(0,0,0,.6)";
          wrap.appendChild(dot);
          if (labelOthers) {
            const lbl = document.createElement("div");
            lbl.textContent = fmtId(r);
            lbl.style.cssText = `font:600 10px 'Segoe UI',system-ui;color:#e0b43a;white-space:nowrap;margin-top:1px;text-shadow:${dark ? "0 0 3px #000,0 0 4px #000" : "0 0 3px #fff,0 0 4px #fff"}`;
            wrap.appendChild(lbl);
          }
          wrap.title = `${fmtId(r)} - relays ${r.count}x (not a direct link)`;
          new maplibregl.Marker({ element: wrap, anchor: labelOthers ? "top" : "center" }).setLngLat([r.lon, r.lat]).addTo(map);
        }
      }

      for (const n of mappable) {
        if (n.mine) continue; // draw others first, mine on top
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;cursor:pointer";
        const dot = document.createElement("div");
        dot.style.cssText = "width:11px;height:11px;border-radius:50%;background:#a4a39c;border:1.5px solid #0b0b0a;box-shadow:0 1px 2px rgba(0,0,0,.6)";
        wrap.appendChild(dot);
        if (labelOthers) {
          const lbl = document.createElement("div");
          lbl.textContent = fmtId(n);
          lbl.style.cssText = `font:600 10px 'Segoe UI',system-ui;color:${dark ? "#c9c8c2" : "#3a3a37"};white-space:nowrap;margin-top:1px;text-shadow:${dark ? "0 0 3px #000,0 0 4px #000" : "0 0 3px #fff,0 0 4px #fff"}`;
          wrap.appendChild(lbl);
        }
        wrap.title = `${fmtId(n)}${n.role ? " (" + n.role + ")" : ""}`;
        wrap.onclick = () => { window.location.href = `/nodes/${n.id}/reach`; };
        new maplibregl.Marker({ element: wrap, anchor: labelOthers ? "top" : "center" }).setLngLat([n.lon, n.lat]).addTo(map);
      }
      for (const n of mappable) {
        if (!n.mine) continue;
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;cursor:pointer";
        const dot = document.createElement("div");
        dot.style.cssText = "width:18px;height:18px;border-radius:50%;background:#b98cff;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.8)";
        const lbl = document.createElement("div");
        lbl.textContent = fmtId(n);
        lbl.style.cssText = `font:700 11px 'Segoe UI',system-ui;color:${dark ? "#f2f1ed" : "#0b0b0a"};white-space:nowrap;margin-top:2px;text-shadow:${dark ? "0 0 3px #000,0 0 4px #000" : "0 0 3px #fff,0 0 4px #fff"}`;
        wrap.appendChild(dot); wrap.appendChild(lbl);
        wrap.onclick = () => { window.location.href = `/nodes/${n.id}/reach`; };
        new maplibregl.Marker({ element: wrap, anchor: "top" }).setLngLat([n.lon, n.lat]).addTo(map);
      }

      const b = new maplibregl.LngLatBounds([first.lon, first.lat], [first.lon, first.lat]);
      for (const n of mappable) b.extend([n.lon, n.lat]);
      if (showRelay) for (const r of relPos) b.extend([r.lon, r.lat]);
      if (mappable.length > 1 || (showRelay && relPos.length)) map.fitBounds(b, { padding: 56, maxZoom: 12, duration: 0 });
    });

    return () => map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, stamp, showRelay]);

  if (!hasAny) {
    return <div className="rounded-xl border border-line bg-raised/40 p-4 text-[13px] text-ink-faint">None of your claimed nodes (or their neighbors) have a position yet, so there is nothing to map. The per-node list below still applies.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-mute">
        <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => setDark((v) => !v)}>{dark ? "Light" : "Dark"} map</button>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full" style={{ background: "#b98cff", border: "2px solid #fff" }} /> your nodes</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#a4a39c" }} /> heard by / hears</span>
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4" style={{ background: "#3f9e63" }} /> direct</span>
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4" style={{ background: "#60a5fa" }} /> neighbor</span>
        {relayers.length > 0 && (
          <label className="flex items-center gap-1.5" title="Gateways that hear your fleet only via a relay (not a direct link)">
            <input type="checkbox" checked={showRelay} onChange={(e) => setShowRelay(e.target.checked)} />
            <span className="inline-block h-0.5 w-4" style={{ background: "repeating-linear-gradient(90deg,#e0b43a,#e0b43a 3px,transparent 3px,transparent 6px)" }} /> relayed-by ({relayers.length})
          </label>
        )}
        <span className="ml-auto text-ink-faint">{mappable.length} of {nodes.length} nodes mapped{showRelay ? `, ${relPos.length} relayers` : ""}</span>
      </div>
      <div ref={wrapRef} className="h-[62vh] w-full overflow-hidden rounded-xl border border-line bg-canvas" />
    </div>
  );
}
