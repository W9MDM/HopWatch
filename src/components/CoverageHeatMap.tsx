"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { DARK_TILES, DARK_ATTRIB } from "../lib/mapicons.ts";
import { cn } from "../lib/cn.ts";

export interface CoverageSample { lat: number; lon: number; snr: number | null; rssi: number | null; hops: number | null; n: number }
interface Filter { channelId?: string; days?: number }
type Mode = "signal" | "reach";

// Signal mode: SNR quality bands. LoRa long-range presets decode down to about -20 dB, so anything
// heard direct is real coverage; the color says HOW WELL it was heard.
const SNR_KEY: [string, string][] = [
  ["Excellent (>= 5 dB)", "#2f9e5a"],
  ["Good (0 to 5 dB)", "#8ab84f"],
  ["Fair (-7 to 0 dB)", "#e0b43a"],
  ["Weak (-15 to -7 dB)", "#e8792f"],
  ["Marginal (< -15 dB)", "#e0362f"],
];
// Reach mode: fewest hops from that spot to the mesh.
const HOP_KEY: [string, string][] = [
  ["Direct (0 hops)", "#2f9e5a"],
  ["1 hop", "#8ab84f"],
  ["2 hops", "#e0b43a"],
  ["3 hops", "#e8792f"],
  ["4+ / unknown", "#e0362f"],
];
const DAY_OPTS: [string, number][] = [["24h", 1], ["7d", 7], ["30d", 30], ["90d", 90], ["1y", 365], ["All", 3650]];

export function CoverageHeatMap({ samples, mode, tile, channels, filter, defaultCenter = null }: {
  samples: CoverageSample[];
  mode: Mode;
  tile: { url: string; attribution: string; darkUrl?: string; darkAttribution?: string };
  channels: string[];
  filter: Filter;
  defaultCenter?: { lat: number; lon: number; zoom: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [dark, setDark] = useState(true);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem("hopwatch_map_dark") === "0") setDark(false);
  }, []);

  const setParam = (key: string, value: string) => {
    const sp = new URLSearchParams();
    if (filter.channelId) sp.set("channel", filter.channelId);
    if (filter.days) sp.set("days", String(filter.days));
    if (mode !== "signal") sp.set("mode", mode);
    if (value) sp.set(key, value); else sp.delete(key);
    router.push(`/wardrive${sp.toString() ? `?${sp}` : ""}`);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const base = dark
      ? { url: tile.darkUrl ?? DARK_TILES, attribution: tile.darkAttribution ?? DARK_ATTRIB }
      : { url: tile.url, attribution: tile.attribution };
    const start = samples[0];
    const map = new maplibregl.Map({
      container: el,
      style: { version: 8, sources: { base: { type: "raster", tiles: [base.url], tileSize: 256, attribution: base.attribution } }, layers: [{ id: "base", type: "raster", source: "base" }] },
      center: defaultCenter ? [defaultCenter.lon, defaultCenter.lat] : start ? [start.lon, start.lat] : [0, 20],
      zoom: defaultCenter ? defaultCenter.zoom : start ? 10 : 1.5,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const fc = {
      type: "FeatureCollection" as const,
      features: samples.map((s) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
        // In reach mode a null hop count (relayed, unknown depth) is bucketed as 4 (worst band).
        properties: { snr: s.snr ?? -20, hops: s.hops == null ? 4 : s.hops, n: s.n, rssi: s.rssi },
      })),
    };

    // Color expression: SNR ramp in signal mode, hop steps in reach mode.
    const colorExpr = mode === "reach"
      ? ["step", ["get", "hops"], "#2f9e5a", 1, "#8ab84f", 2, "#e0b43a", 3, "#e8792f", 4, "#e0362f"] as unknown as maplibregl.ExpressionSpecification
      : ["interpolate", ["linear"], ["get", "snr"], -15, "#e0362f", -7, "#e8792f", 0, "#e0b43a", 5, "#8ab84f", 10, "#2f9e5a"] as unknown as maplibregl.ExpressionSpecification;

    const popBg = dark ? "#141412" : "#ffffff";
    const popBorder = dark ? "#272725" : "#d4d4d4";
    const popText = dark ? "#f2f1ed" : "#0b0b0a";

    map.on("load", () => {
      map.addSource("samples", { type: "geojson", data: fc });
      map.addLayer({
        id: "cells", type: "circle", source: "samples",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3, 12, 6, 16, 10],
          "circle-color": colorExpr,
          "circle-opacity": 0.8,
          "circle-stroke-width": 0.5,
          "circle-stroke-color": dark ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.6)",
        },
      });
      map.on("click", "cells", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const pr = f.properties as { snr: number; hops: number; n: number; rssi: number | null };
        const g = f.geometry as unknown as { coordinates: [number, number] };
        const [lon, lat] = g.coordinates;
        const headline = mode === "reach"
          ? `Reached in ${pr.hops >= 4 ? "4+" : pr.hops} hop${pr.hops === 1 ? "" : "s"}`
          : `Best SNR ${Number(pr.snr).toFixed(1)} dB`;
        const detail = mode === "reach"
          ? `${pr.n} reception${pr.n === 1 ? "" : "s"} heard here`
          : `${pr.rssi != null ? `RSSI ${pr.rssi} dBm<br>` : ""}${pr.n} direct reception${pr.n === 1 ? "" : "s"}`;
        new maplibregl.Popup({ className: "hw-popup", closeButton: false })
          .setLngLat([lon, lat])
          .setHTML(
            `<div style="background:${popBg};border:1px solid ${popBorder};color:${popText};border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.5">
               <div style="font-weight:600">${headline}</div>
               <div>${detail}</div>
               <div style="opacity:.6">${lat.toFixed(4)}, ${lon.toFixed(4)}</div>
             </div>`,
          )
          .addTo(map);
      });
      map.on("mouseenter", "cells", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "cells", () => { map.getCanvas().style.cursor = ""; });
    });

    return () => map.remove();
  }, [samples, mode, tile, dark, defaultCenter]);

  const btn = (active: boolean) =>
    cn("rounded-md border px-2.5 py-1 text-[12px]", active ? "border-accent bg-accent/10 text-ink" : "border-line text-ink-mute hover:text-ink");
  const legend = mode === "reach" ? HOP_KEY : SNR_KEY;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          <button className={btn(mode === "signal")} onClick={() => setParam("mode", "signal")}>Signal</button>
          <button className={btn(mode === "reach")} onClick={() => setParam("mode", "reach")}>Reach</button>
        </div>
        <span className="text-line">|</span>
        <div className="flex gap-1">
          {DAY_OPTS.map(([label, d]) => (
            <button key={d} className={btn((filter.days ?? 90) === d)} onClick={() => setParam("days", String(d))}>{label}</button>
          ))}
        </div>
        {channels.length > 0 && (
          <>
            <span className="text-line">|</span>
            <select
              className="rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-ink"
              value={filter.channelId ?? ""}
              onChange={(e) => setParam("channel", e.target.value)}
            >
              <option value="">All channels</option>
              {channels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </>
        )}
        <span className="text-line">|</span>
        <button className={btn(dark)} onClick={() => { const v = !dark; setDark(v); try { localStorage.setItem("hopwatch_map_dark", v ? "1" : "0"); } catch { /* ignore */ } }}>
          {dark ? "Dark" : "Light"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-mute">
        {legend.map(([label, color]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
            {label}
          </span>
        ))}
      </div>

      <div ref={ref} className="h-[70vh] w-full overflow-hidden rounded-xl border border-line" />
    </div>
  );
}
