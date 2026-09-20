"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export interface ReachMapReceiver { lat: number | null; lon: number | null; name: string | null; distance_km: number | null; avg_snr: number | null; count: number }
export interface ReachMapNode { lat: number | null; lon: number | null; name: string }

// A focused reach map: the node in the middle, a line out to every direct receiver that has a
// position, receivers colored by signal. Follows the map conventions (controls + legend above the
// canvas, themed). Reuses the site tile config passed from the server page.
export function ReachMap({ node, receivers, relayers = [], tile }: {
  node: ReachMapNode;
  receivers: ReachMapReceiver[];
  relayers?: ReachMapReceiver[];
  tile: { url: string; attribution: string; darkUrl?: string; darkAttribution?: string };
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [dark, setDark] = useState(true);
  const [showRelay, setShowRelay] = useState(false);

  const withPos = receivers.filter((r) => r.lat != null && r.lon != null) as (ReachMapReceiver & { lat: number; lon: number })[];
  const relPos = relayers.filter((r) => r.lat != null && r.lon != null) as (ReachMapReceiver & { lat: number; lon: number })[];
  const hasNode = node.lat != null && node.lon != null;
  const snrColor = (snr: number | null) => (snr == null ? "#6f6e67" : snr >= 0 ? "#3f9e63" : snr >= -10 ? "#e0b43a" : "#f0562f");

  useEffect(() => {
    if (!wrapRef.current || !hasNode) return;
    const url = dark ? tile.darkUrl ?? tile.url : tile.url;
    const attribution = (dark ? tile.darkAttribution ?? tile.attribution : tile.attribution) || "";
    const map = new maplibregl.Map({
      container: wrapRef.current,
      style: { version: 8, sources: { base: { type: "raster", tiles: [url], tileSize: 256, attribution } }, layers: [{ id: "base", type: "raster", source: "base" }] },
      center: [node.lon!, node.lat!],
      zoom: 9,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on("load", () => {
      const lines = {
        type: "FeatureCollection" as const,
        features: withPos.map((r) => ({ type: "Feature" as const, properties: { snr: snrColor(r.avg_snr) }, geometry: { type: "LineString" as const, coordinates: [[node.lon!, node.lat!], [r.lon, r.lat]] } })),
      };
      map.addSource("reach-lines", { type: "geojson", data: lines });
      map.addLayer({ id: "reach-lines", type: "line", source: "reach-lines", paint: { "line-color": ["get", "snr"], "line-width": 1.4, "line-opacity": 0.55 } });

      // Relayed-by layer (optional): amber dashed lines + hollow markers to the gateways that carry
      // this node's traffic via a relay. Drawn under the direct lines/markers so direct stays primary.
      if (showRelay && relPos.length) {
        map.addSource("relay-lines", { type: "geojson", data: { type: "FeatureCollection", features: relPos.map((r) => ({ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: [[node.lon!, node.lat!], [r.lon, r.lat]] } })) } });
        map.addLayer({ id: "relay-lines", type: "line", source: "relay-lines", paint: { "line-color": "#e0b43a", "line-width": 1, "line-opacity": 0.35, "line-dasharray": [2, 2] } }, "reach-lines");
        for (const r of relPos) {
          const el = document.createElement("div");
          el.style.cssText = "width:9px;height:9px;border-radius:50%;background:transparent;border:1.5px solid #e0b43a;box-shadow:0 1px 2px rgba(0,0,0,.6)";
          el.title = `${r.name ?? "relayer"} - relays ${r.count}x (not a direct link)`;
          new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([r.lon, r.lat]).addTo(map);
        }
      }

      // Receiver markers.
      for (const r of withPos) {
        const el = document.createElement("div");
        el.style.cssText = `width:12px;height:12px;border-radius:50%;background:${snrColor(r.avg_snr)};border:2px solid #0b0b0a;box-shadow:0 1px 3px rgba(0,0,0,.7)`;
        el.title = `${r.name ?? "receiver"} - ${r.count} rx${r.avg_snr != null ? `, ${r.avg_snr.toFixed(1)} dB` : ""}${r.distance_km != null ? `, ${r.distance_km.toFixed(1)} km` : ""}`;
        new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([r.lon, r.lat]).addTo(map);
      }
      // The node itself.
      const nel = document.createElement("div");
      nel.style.cssText = "width:20px;height:20px;border-radius:50%;background:#b98cff;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.8)";
      nel.title = node.name;
      new maplibregl.Marker({ element: nel, anchor: "center" }).setLngLat([node.lon!, node.lat!]).addTo(map);

      // Fit to node + receivers (+ relayers when that layer is shown).
      const b = new maplibregl.LngLatBounds([node.lon!, node.lat!], [node.lon!, node.lat!]);
      for (const r of withPos) b.extend([r.lon, r.lat]);
      if (showRelay) for (const r of relPos) b.extend([r.lon, r.lat]);
      if (withPos.length || (showRelay && relPos.length)) map.fitBounds(b, { padding: 48, maxZoom: 13, duration: 0 });
    });

    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, showRelay]);

  if (!hasNode) {
    return <div className="rounded-xl border border-line bg-raised/40 p-4 text-[13px] text-ink-faint">No position for this node, so its reach cannot be mapped. The receivers and links below still apply.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-mute">
        <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => setDark((v) => !v)}>{dark ? "Light" : "Dark"} map</button>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full" style={{ background: "#b98cff", border: "2px solid #fff" }} /> this node</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#3f9e63" }} /> strong</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#e0b43a" }} /> ok</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#f0562f" }} /> weak</span>
        {relayers.length > 0 && (
          <label className="flex items-center gap-1.5" title="Gateways that carry this node's traffic via a relay (not a direct link)">
            <input type="checkbox" checked={showRelay} onChange={(e) => setShowRelay(e.target.checked)} />
            <span className="inline-block h-0.5 w-4" style={{ background: "repeating-linear-gradient(90deg,#e0b43a,#e0b43a 3px,transparent 3px,transparent 6px)" }} /> relayed-by ({relayers.length})
          </label>
        )}
        <span className="ml-auto text-ink-faint">{withPos.length} of {receivers.length} receivers mapped{showRelay ? `, ${relPos.length} relayers` : ""}</span>
      </div>
      <div ref={wrapRef} className="h-[52vh] w-full overflow-hidden rounded-xl border border-line bg-canvas" />
    </div>
  );
}
