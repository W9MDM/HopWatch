"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildNodeElement, DARK_TILES, DARK_ATTRIB, estColor } from "../lib/mapicons.ts";
import { circlePolygon } from "../lib/geo.ts";

// Compact single-node map for the node page. Shows the node's real (GPS) or estimated
// position; estimated positions use the dashed marker + a translucent confidence circle.
export function NodeMiniMap({ lat, lon, name, role, isGateway, source, confidenceRadiusM, tile, track }: {
  lat: number; lon: number; name: string; role: string | null; isGateway: boolean;
  source: "gps" | "estimated"; confidenceRadiusM: number | null; tile: { url: string; attribution: string; darkUrl?: string; darkAttribution?: string };
  track?: [number, number][]; // [lon,lat] path for mobile nodes
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dark, setDark] = useState(true);

  useEffect(() => {
    if (typeof localStorage !== "undefined" && localStorage.getItem("hopwatch_map_dark") === "0") setDark(false);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const base = dark ? { url: tile.darkUrl ?? DARK_TILES, attribution: tile.darkAttribution ?? DARK_ATTRIB } : { url: tile.url, attribution: tile.attribution };
    const estimated = source === "estimated";
    const map = new maplibregl.Map({
      container: el,
      style: { version: 8, sources: { base: { type: "raster", tiles: [base.url], tileSize: 256, attribution: base.attribution } }, layers: [{ id: "base", type: "raster", source: "base" }] },
      center: [lon, lat],
      zoom: estimated && confidenceRadiusM ? 11 : 13,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      // Mobility track (if the node has moved): a dashed path through its position history.
      if (track && track.length > 1) {
        map.addSource("track", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: track }, properties: {} } });
        map.addLayer({ id: "track", type: "line", source: "track", paint: { "line-color": dark ? "#6ab0ff" : "#1d4ed8", "line-width": 2, "line-opacity": 0.8, "line-dasharray": [2, 1] } });
        const lons = track.map((p) => p[0]), lats = track.map((p) => p[1]);
        map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 32, duration: 0, maxZoom: 14 });
      }
      if (estimated && confidenceRadiusM) {
        const est = estColor(dark);
        map.addSource("conf", { type: "geojson", data: { type: "Feature", geometry: { type: "Polygon", coordinates: [circlePolygon({ lat, lon }, confidenceRadiusM)] }, properties: {} } });
        map.addLayer({ id: "conf-fill", type: "fill", source: "conf", paint: { "fill-color": est, "fill-opacity": 0.12 } });
        map.addLayer({ id: "conf-line", type: "line", source: "conf", paint: { "line-color": est, "line-width": 1.5, "line-opacity": 0.6, "line-dasharray": [2, 2] } });
        map.fitBounds([[lon - 0.05, lat - 0.05], [lon + 0.05, lat + 0.05]], { padding: 24, duration: 0 });
      }
      const elm = buildNodeElement({ name, role, isGateway, dark, showLabel: false, estimated });
      new maplibregl.Marker({ element: elm, anchor: "center" }).setLngLat([lon, lat]).addTo(map);
    });

    return () => map.remove();
  }, [lat, lon, name, role, isGateway, source, confidenceRadiusM, tile, dark, track]);

  return <div ref={ref} className="h-64 w-full overflow-hidden rounded-xl border border-line" />;
}
