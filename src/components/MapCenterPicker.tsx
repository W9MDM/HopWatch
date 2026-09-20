"use client";

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export interface MapCenter { lat: number | null; lon: number | null; zoom: number }

// Click-to-set map-center picker for the admin settings page. Renders a small map; clicking
// drops the center marker and reports lat/lon, and panning/zooming reports the zoom. Purely a
// control: it does not persist anything itself (the parent form saves via /api/v1/admin/general).
export function MapCenterPicker({ value, onChange, tileUrl, tileAttribution }: {
  value: MapCenter;
  onChange: (v: MapCenter) => void;
  tileUrl: string;
  tileAttribution: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Build the map once. Live value changes are pushed in via the second effect so we do not
  // tear down and recreate the map on every keystroke.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const hasCenter = value.lat != null && value.lon != null;
    const map = new maplibregl.Map({
      container: el,
      style: { version: 8, sources: { base: { type: "raster", tiles: [tileUrl], tileSize: 256, attribution: tileAttribution } }, layers: [{ id: "base", type: "raster", source: "base" }] },
      center: hasCenter ? [value.lon!, value.lat!] : [0, 20],
      zoom: hasCenter ? value.zoom : 1.5,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    const marker = new maplibregl.Marker({ color: "#3f9e63", draggable: true });
    if (hasCenter) marker.setLngLat([value.lon!, value.lat!]).addTo(map);
    markerRef.current = marker;

    const round = (n: number) => Math.round(n * 1e5) / 1e5;
    const set = (lng: number, lat: number) => {
      marker.setLngLat([lng, lat]).addTo(map);
      onChangeRef.current({ lat: round(lat), lon: round(lng), zoom: Math.round(map.getZoom() * 10) / 10 });
    };
    map.on("click", (e) => set(e.lngLat.lng, e.lngLat.lat));
    marker.on("dragend", () => { const p = marker.getLngLat(); set(p.lng, p.lat); });
    map.on("zoomend", () => {
      const p = markerRef.current?.getLngLat();
      if (p) onChangeRef.current({ lat: round(p.lat), lon: round(p.lng), zoom: Math.round(map.getZoom() * 10) / 10 });
    });

    return () => { map.remove(); mapRef.current = null; markerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileUrl, tileAttribution]);

  // Reflect external edits (typing lat/lon/zoom in the number fields) onto the map/marker.
  useEffect(() => {
    const map = mapRef.current, marker = markerRef.current;
    if (!map || !marker) return;
    if (value.lat != null && value.lon != null) {
      marker.setLngLat([value.lon, value.lat]).addTo(map);
      const c = map.getCenter();
      if (Math.abs(c.lat - value.lat) > 1e-4 || Math.abs(c.lng - value.lon) > 1e-4 || Math.abs(map.getZoom() - value.zoom) > 0.05) {
        map.easeTo({ center: [value.lon, value.lat], zoom: value.zoom, duration: 300 });
      }
    } else {
      marker.remove();
    }
  }, [value.lat, value.lon, value.zoom]);

  return <div ref={ref} className="h-64 w-full max-w-2xl overflow-hidden rounded-lg border border-line" />;
}
