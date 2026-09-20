"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

interface Frame {
  bucket: string;
  receptions: number;
  active: number[];
}

// Mesh replay: scrub or play through hourly frames built from the rollups (never
// raw rows), lighting up the nodes active in each hour on the map (spec §: replay).
export function ReplayMap({
  frames,
  positions,
  tile,
}: {
  frames: Frame[];
  positions: Record<number, [number, number]>;
  tile: { url: string; attribution: string; darkUrl?: string; darkAttribution?: string };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const coords = Object.values(positions);
    const center: [number, number] = coords[0] ?? [0, 20];
    const map = new maplibregl.Map({
      container: el,
      style: {
        version: 8,
        sources: { base: { type: "raster", tiles: [tile.url], tileSize: 256, attribution: tile.attribution } },
        layers: [{ id: "base", type: "raster", source: "base" }],
      },
      center,
      zoom: coords.length ? 7 : 1.5,
    });
    mapRef.current = map;
    map.on("load", () => {
      map.addSource("active", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "active",
        type: "circle",
        source: "active",
        paint: { "circle-radius": 4, "circle-color": "#3f9e63", "circle-stroke-color": "#0b0b0a", "circle-stroke-width": 1 },
      });
      readyRef.current = true;
      renderFrame(0);
    });
    return () => {
      readyRef.current = false;
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, tile]);

  function renderFrame(i: number) {
    const map = mapRef.current;
    const frame = frames[i];
    if (!map || !readyRef.current || !frame) return;
    const src = map.getSource("active") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const features = frame.active
      .map((id) => positions[id])
      .filter(Boolean)
      .map((c) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: c as [number, number] }, properties: {} }));
    src.setData({ type: "FeatureCollection", features });
  }

  useEffect(() => {
    renderFrame(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % frames.length), 700);
    return () => clearInterval(t);
  }, [playing, frames.length]);

  const cur = frames[idx];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary h-8 px-3 text-[13px]" onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={idx}
          onChange={(e) => {
            setPlaying(false);
            setIdx(Number(e.target.value));
          }}
          className="flex-1 accent-[var(--color-accent)]"
        />
        <span className="mono text-[12px] text-ink-mute">
          {cur ? `${cur.bucket} UTC · ${cur.receptions} rx · ${cur.active.length} nodes` : "no data"}
        </span>
      </div>
      <div ref={ref} className="h-[65vh] w-full overflow-hidden rounded-xl border border-line" />
    </div>
  );
}
