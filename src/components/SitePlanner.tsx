"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { DARK_TILES, DARK_ATTRIB } from "../lib/mapicons.ts";
import { circlePolygon, haversineKm } from "../lib/geo.ts";
import { planSite, type CoverageParams, type SitePrediction } from "../lib/coverage.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { cn } from "../lib/cn.ts";

export interface PlannerMapNode {
  node_id: number; name: string; latitude: number; longitude: number; direct_gateways: number;
}

const CLR_OUT = "#6f6e67"; // out of range
const CLR_IN = "#5bb37e"; // in range, already covered
const CLR_NEW = "#e0b43a"; // in range and currently a gap/single-point (highest value)

export function SitePlanner({ nodes, tile, coverageParams }: {
  nodes: PlannerMapNode[]; tile: { url: string; attribution: string; darkUrl?: string; darkAttribution?: string }; coverageParams: CoverageParams;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);
  const [dark, setDark] = useState(true);
  const [candidate, setCandidate] = useState<{ lat: number; lon: number } | null>(null);
  const [eirp, setEirp] = useState(coverageParams.defaultEirpDbm);
  const [height, setHeight] = useState(coverageParams.defaultHeightM);

  useEffect(() => {
    try { if (localStorage.getItem("hopwatch_map_dark") === "0") setDark(false); } catch { /* ignore */ }
  }, []);

  const plan = candidate
    ? planSite({ lat: candidate.lat, lon: candidate.lon, eirpDbm: eirp, heightM: height }, nodes, coverageParams, haversineKm)
    : null;

  // Push current candidate/plan onto the map sources.
  const render = useCallback(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const byId = new Map((plan?.predictions ?? []).map((p) => [p.node_id, p]));
    const nodeFC = {
      type: "FeatureCollection" as const,
      features: nodes.map((n) => {
        const p = byId.get(n.node_id);
        const color = !p || !p.in_range ? CLR_OUT : p.newly_covered ? CLR_NEW : CLR_IN;
        return { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [n.longitude, n.latitude] }, properties: { color, r: p?.in_range ? 5 : 3 } };
      }),
    };
    (map.getSource("plan-nodes") as maplibregl.GeoJSONSource | undefined)?.setData(nodeFC);

    const covFC = {
      type: "FeatureCollection" as const,
      features: candidate && plan
        ? [{ type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [circlePolygon({ lat: candidate.lat, lon: candidate.lon }, plan.radius_km * 1000)] }, properties: {} }]
        : [],
    };
    (map.getSource("plan-coverage") as maplibregl.GeoJSONSource | undefined)?.setData(covFC);

    const candFC = {
      type: "FeatureCollection" as const,
      features: candidate ? [{ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [candidate.lon, candidate.lat] }, properties: {} }] : [],
    };
    (map.getSource("plan-candidate") as maplibregl.GeoJSONSource | undefined)?.setData(candFC);
  }, [nodes, plan, candidate]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const start = nodes[0];
    const base = dark ? { url: tile.darkUrl ?? DARK_TILES, attribution: tile.darkAttribution ?? DARK_ATTRIB } : { url: tile.url, attribution: tile.attribution };
    const map = new maplibregl.Map({
      container: el,
      style: { version: 8, sources: { base: { type: "raster", tiles: [base.url], tileSize: 256, attribution: base.attribution } }, layers: [{ id: "base", type: "raster", source: "base" }] },
      center: start ? [start.longitude, start.latitude] : [0, 20],
      zoom: start ? 8 : 1.5,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    loadedRef.current = false;

    map.on("load", () => {
      map.addSource("plan-coverage", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "plan-coverage-fill", type: "fill", source: "plan-coverage", paint: { "fill-color": "#3f9e63", "fill-opacity": 0.12 } });
      map.addLayer({ id: "plan-coverage-line", type: "line", source: "plan-coverage", paint: { "line-color": "#3f9e63", "line-width": 1.5, "line-dasharray": [2, 2] } });
      map.addSource("plan-nodes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "plan-nodes-c", type: "circle", source: "plan-nodes", paint: { "circle-radius": ["get", "r"], "circle-color": ["get", "color"], "circle-stroke-width": 1, "circle-stroke-color": "rgba(0,0,0,0.4)" } });
      map.addSource("plan-candidate", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "plan-candidate-c", type: "circle", source: "plan-candidate", paint: { "circle-radius": 8, "circle-color": "#d92b2b", "circle-stroke-width": 2, "circle-stroke-color": "#fff" } });
      loadedRef.current = true;
      render();
    });

    map.on("click", (e) => setCandidate({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    map.getCanvas().style.cursor = "crosshair";

    return () => { loadedRef.current = false; map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark]);

  useEffect(() => { render(); }, [render]);

  const inRange = (plan?.predictions ?? []).filter((p) => p.in_range);
  const controlCls = "h-9 w-28 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1"><span className="block stat-label">Latitude</span><input type="number" step="0.0001" value={candidate ? candidate.lat.toFixed(5) : ""} onChange={(e) => setCandidate((c) => ({ lat: Number(e.target.value), lon: c?.lon ?? 0 }))} className={controlCls} placeholder="click map" /></label>
        <label className="space-y-1"><span className="block stat-label">Longitude</span><input type="number" step="0.0001" value={candidate ? candidate.lon.toFixed(5) : ""} onChange={(e) => setCandidate((c) => ({ lat: c?.lat ?? 0, lon: Number(e.target.value) }))} className={controlCls} placeholder="click map" /></label>
        <label className="space-y-1"><span className="block stat-label">EIRP (dBm)</span><input type="number" value={String(eirp)} onChange={(e) => setEirp(Number(e.target.value))} className={controlCls} /></label>
        <label className="space-y-1"><span className="block stat-label">Antenna height (m)</span><input type="number" value={String(height)} onChange={(e) => setHeight(Number(e.target.value))} className={controlCls} /></label>
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} /> Dark</label>
        {candidate && <button className="btn btn-outline h-9 px-3 text-[13px]" onClick={() => setCandidate(null)}>Clear</button>}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-[13px]">
        <span className="text-ink-faint">Click the map to place a candidate node.</span>
        {plan && (
          <>
            <span className="text-ink">Coverage radius: <span className="font-semibold tabular-nums">{plan.radius_km.toFixed(1)} km</span></span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CLR_IN }} /> In range: <span className="font-semibold tabular-nums">{plan.in_range}</span></span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CLR_NEW }} /> Newly covered gaps: <span className="font-semibold tabular-nums">{plan.newly_covered}</span></span>
          </>
        )}
      </div>

      <div ref={ref} className="h-[520px] w-full overflow-hidden rounded-lg border border-line" />

      {plan && inRange.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="data">
            <thead><tr><th>Node</th><th className="text-right">Distance</th><th className="text-right">Predicted RSSI</th><th>Current coverage</th></tr></thead>
            <tbody>
              {inRange.slice(0, 50).map((p: SitePrediction) => {
                const n = nodes.find((x) => x.node_id === p.node_id)!;
                return (
                  <tr key={p.node_id}>
                    <td>{n.name || formatNodeId(p.node_id)}</td>
                    <td className="text-right tabular-nums">{p.distance_km.toFixed(1)} km</td>
                    <td className="text-right tabular-nums">{Math.round(p.predicted_rssi)} dBm</td>
                    <td className={cn(p.newly_covered && "text-gold-ink")}>{p.newly_covered ? "gap / single point (would newly cover)" : "already covered"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
