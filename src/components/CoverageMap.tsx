"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { formatNodeId } from "../meshtastic/types.ts";
import { DARK_TILES, DARK_ATTRIB, estColor, buildNodeElement, NODE_TYPES, matchesNodeType } from "../lib/mapicons.ts";
import { circlePolygon } from "../lib/geo.ts";
import { coverageRadiusKm, type CoverageParams } from "../lib/coverage.ts";
import { MapLayersPanel } from "./MapLayersPanel.tsx";
import { cn } from "../lib/cn.ts";

export interface CoverageHeard { gateway_id: number; name: string | null; broker: string | null; status: string; rssi: number | null }
export interface CoverageNode {
  node_id: number; long_name: string | null; short_name: string | null; role: string | null; is_gateway: number;
  latitude: number; longitude: number; direct_gateways: number; best_rssi: number | null;
  altitude_m: number | null; rf_height_m: number | null; rf_eirp_dbm: number | null;
  heard_by?: CoverageHeard[];
}
export interface CoverageEstimate {
  node_id: number; long_name: string | null; short_name: string | null; role: string | null;
  latitude: number; longitude: number; confidence_radius_m: number; method_tier: number;
  receiver_count: number; possibly_mobile: number;
}
interface Filter { broker?: string; channelId?: string }

function coverageColor(n: number): string {
  if (n <= 0) return "#d92b2b";
  if (n === 1) return "#e0b43a";
  if (n === 2) return "#5bb37e";
  return "#3f9e63";
}
const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
const COV_KEY: [string, string][] = [
  ["No direct gateway (gap)", "#d92b2b"],
  ["1 gateway (single point)", "#e0b43a"],
  ["2 gateways", "#5bb37e"],
  ["3+ gateways (redundant)", "#3f9e63"],
];

export function CoverageMap({ nodes, tile, brokers, channels, filter, estimates, coverageParams, canClaim = false, defaultCenter = null }: {
  nodes: CoverageNode[]; tile: { url: string; attribution: string; darkUrl?: string; darkAttribution?: string };
  brokers: string[]; channels: string[]; filter: Filter; estimates: CoverageEstimate[]; coverageParams: CoverageParams; canClaim?: boolean;
  defaultCenter?: { lat: number; lon: number; zoom: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [dark, setDark] = useState(true);
  const [showEst, setShowEst] = useState(true);
  const [showAccuracy, setShowAccuracy] = useState(true);
  const [showCoverage, setShowCoverage] = useState(false);
  // RF-heard only: hide nodes no gateway has heard over RF (direct or relayed) recently,
  // i.e. nodes present only via their own MQTT uplink. heard_by is the RF link roster.
  const [rfOnly, setRfOnly] = useState(false);
  const [nodeType, setNodeType] = useState("all");
  const persist = (key: string, v: boolean) => { try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* ignore */ } };

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem("hopwatch_map_dark") === "0") setDark(false);
    if (localStorage.getItem("hopwatch_map_estimated") === "0") setShowEst(false);
    if (localStorage.getItem("hopwatch_map_accuracy") === "0") setShowAccuracy(false);
    if (localStorage.getItem("hopwatch_coverage_rings") === "1") setShowCoverage(true);
    if (localStorage.getItem("hopwatch_map_rfonly") === "1") setRfOnly(true);
    const nt = localStorage.getItem("hopwatch_map_type");
    if (nt) setNodeType(nt);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const typedNodes = nodes.filter((n) => matchesNodeType(n.role, !!n.is_gateway, nodeType) && (!rfOnly || (n.heard_by?.length ?? 0) > 0));
    const typedEst = estimates.filter((e) => matchesNodeType(e.role, false, nodeType));
    const start = typedNodes[0] ?? typedEst[0] ?? nodes[0] ?? estimates[0];
    const base = dark ? { url: tile.darkUrl ?? DARK_TILES, attribution: tile.darkAttribution ?? DARK_ATTRIB } : { url: tile.url, attribution: tile.attribution };
    const map = new maplibregl.Map({
      container: el,
      style: { version: 8, sources: { base: { type: "raster", tiles: [base.url], tileSize: 256, attribution: base.attribution } }, layers: [{ id: "base", type: "raster", source: "base" }] },
      center: defaultCenter ? [defaultCenter.lon, defaultCenter.lat] : start ? [start.longitude, start.latitude] : [0, 20],
      zoom: defaultCenter ? defaultCenter.zoom : start ? 8 : 1.5,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const popBg = dark ? "#141412" : "#ffffff";
    const popBorder = dark ? "#272725" : "#d4d4d4";
    const popText = dark ? "#f2f1ed" : "#0b0b0a";
    const popFaint = dark ? "#8a8a84" : "#6f6e67";
    const est = estColor(dark);
    const shownEst = showEst ? typedEst : [];

    const heardRows = (entries: CoverageHeard[] | undefined): string => {
      if (!entries || entries.length === 0) return "";
      const rows = entries.map((e) => {
        const gw = e.name ? esc(e.name) : formatNodeId(e.gateway_id);
        // broker "node" = our own station receiver heard this over the air (no MQTT
        // involved); every other entry is an RF hearing reported through that broker.
        const via = e.broker === "node"
          ? ` <span style="color:#5bb37e;font-weight:600">via RF (station)</span>`
          : e.broker ? ` <span style="color:${popFaint}">via ${esc(e.broker)}</span>` : "";
        const sig = e.rssi != null ? ` ${e.rssi}dBm` : "";
        // Non-color encoding (accessibility): direct = filled dot, relayed = hollow ring.
        const dot = e.status === "direct" ? "#5bb37e" : "#e0b43a";
        const mark = e.status === "direct" ? `background:${dot}` : `border:1.5px solid ${dot};box-sizing:border-box`;
        return `<div style="display:flex;align-items:center;gap:5px"><span title="${e.status}" style="width:7px;height:7px;border-radius:50%;${mark};flex:none"></span><span style="color:${popText}">${gw}</span>${via}<span style="color:${popFaint};margin-left:auto">${sig}</span></div>`;
      }).join("");
      return `<div style="margin-top:6px;padding-top:5px;border-top:1px solid ${popFaint}33"><div style="color:${popFaint};margin-bottom:2px">Heard over RF by <span style="opacity:.8">(green = direct, yellow = relayed)</span></div>${rows}</div>`;
    };
    const features = typedNodes.map((n) => {
      const name = n.long_name ?? n.short_name ?? String(n.node_id);
      const cov = n.direct_gateways <= 0 ? "gap (no direct gateway)" : n.direct_gateways === 1 ? "single point of failure" : n.direct_gateways === 2 ? "2 gateways" : "well covered";
      const html =
        `<div style="font:12px 'Segoe UI',system-ui;min-width:170px;background:${popBg};color:${popText};` +
        `border:1px solid ${popBorder};border-radius:8px;padding:8px 10px;box-shadow:0 4px 14px rgba(0,0,0,.5)">` +
        `<div style="font-weight:700">${esc(name)}</div>` +
        `<div style="display:grid;gap:2px;margin-top:4px">` +
        `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:${popFaint}">Coverage</span><span>${cov}</span></div>` +
        `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:${popFaint}">Direct gateways</span><span>${n.direct_gateways}</span></div>` +
        `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:${popFaint}">Best signal</span><span>${n.best_rssi != null ? n.best_rssi + " dBm" : "unknown"}</span></div>` +
        `</div>` + heardRows(n.heard_by) +
        (canClaim ? `<button data-claim="${n.node_id}" style="margin-top:8px;width:100%;padding:5px 8px;border-radius:6px;border:1px solid #3f9e63;background:#3f9e63;color:#0b0b0a;font-weight:600;cursor:pointer;font-size:12px">Claim this node</button>` : "") +
        `</div>`;
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [n.longitude, n.latitude] },
        properties: { color: coverageColor(n.direct_gateways), radius: 4 + Math.min(6, Math.max(0, ((n.best_rssi ?? -120) + 120) / 12)), html, node_id: n.node_id, name, lat: n.latitude, lng: n.longitude, role: n.role ?? "" },
      };
    });
    const estCircles = (showAccuracy ? shownEst : []).map((n) => ({
      type: "Feature" as const,
      geometry: { type: "Polygon" as const, coordinates: [circlePolygon({ lat: n.latitude, lon: n.longitude }, n.confidence_radius_m)] },
      properties: {},
    }));

    // Predicted coverage: a range ring per node from its RF profile (height/EIRP) + link
    // budget. Drawn under everything so the dots stay readable.
    const covRings = (showCoverage ? typedNodes : []).map((n) => {
      const km = coverageRadiusKm({ eirpDbm: n.rf_eirp_dbm, heightM: n.rf_height_m, altitudeM: n.altitude_m }, coverageParams);
      return { type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [circlePolygon({ lat: n.latitude, lon: n.longitude }, km * 1000)] }, properties: {} };
    });

    const markers: maplibregl.Marker[] = [];
    const popup = new maplibregl.Popup({ closeButton: false, closeOnMove: true, className: "hw-popup" });
    // Keep-open + claim wiring so the hover popup can host a clickable Claim button.
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } };
    const scheduleClose = () => { cancelClose(); closeTimer = setTimeout(() => popup.remove(), 160); };
    const wireClaim = (el: HTMLElement, node: { id: number; name: string; lat: number; lng: number; role: string | null }) => {
      const btn = el.querySelector<HTMLButtonElement>("[data-claim]");
      if (!btn) return;
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        btn.disabled = true; btn.textContent = "Claiming...";
        try {
          const r = await fetch("/api/v1/owned/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ num_id: node.id, name: node.name, lat: node.lat, lng: node.lng, role: node.role }) });
          const d = await r.json().catch(() => ({}));
          if (r.ok && (d.status === "claimed" || d.status === "mine")) { btn.textContent = d.status === "mine" ? "You own this node" : "Claimed ✓"; btn.style.opacity = "0.7"; }
          else { btn.textContent = d.error ?? "Claim failed"; btn.disabled = false; }
        } catch { btn.textContent = "Claim failed"; btn.disabled = false; }
      };
    };
    const showPopup = (lngLat: [number, number], html: string, claim?: { id: number; name: string; lat: number; lng: number; role: string | null }) => {
      cancelClose();
      popup.setLngLat(lngLat).setHTML(html).addTo(map);
      const pe = popup.getElement();
      if (pe) {
        if (!pe.dataset.hwWired) { pe.dataset.hwWired = "1"; pe.addEventListener("mouseenter", cancelClose); pe.addEventListener("mouseleave", scheduleClose); }
        if (claim) wireClaim(pe, claim);
      }
    };

    map.on("load", () => {
      map.addSource("cov-rings", { type: "geojson", data: { type: "FeatureCollection", features: covRings } });
      map.addLayer({ id: "cov-rings-fill", type: "fill", source: "cov-rings", paint: { "fill-color": "#4b8bd6", "fill-opacity": 0.06 } });
      map.addLayer({ id: "cov-rings-line", type: "line", source: "cov-rings", paint: { "line-color": "#4b8bd6", "line-width": 1, "line-opacity": 0.35 } });

      map.addSource("est-circles", { type: "geojson", data: { type: "FeatureCollection", features: estCircles } });
      map.addLayer({ id: "est-fill", type: "fill", source: "est-circles", paint: { "fill-color": est, "fill-opacity": 0.12 } });
      map.addLayer({ id: "est-outline", type: "line", source: "est-circles", paint: { "line-color": est, "line-width": 1.5, "line-opacity": 0.6, "line-dasharray": [2, 2] } });

      map.addSource("cov", { type: "geojson", data: { type: "FeatureCollection", features } });
      map.addLayer({
        id: "cov", type: "circle", source: "cov",
        paint: { "circle-radius": ["get", "radius"], "circle-color": ["get", "color"], "circle-opacity": 0.85, "circle-stroke-color": dark ? "#0b0b0a" : "#ffffff", "circle-stroke-width": 1.5 },
      });
      map.on("mouseenter", "cov", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const f = e.features?.[0];
        if (!f) return;
        const pr = f.properties ?? {};
        const claim = canClaim && pr.node_id != null ? { id: Number(pr.node_id), name: String(pr.name ?? ""), lat: Number(pr.lat), lng: Number(pr.lng), role: pr.role ? String(pr.role) : null } : undefined;
        showPopup((f.geometry as GeoJSON.Point).coordinates as [number, number], String(pr.html), claim);
      });
      map.on("mouseleave", "cov", () => { map.getCanvas().style.cursor = ""; scheduleClose(); });

      // Estimated (non-GPS) nodes as dashed markers.
      for (const n of shownEst) {
        const c: [number, number] = [n.longitude, n.latitude];
        const name = n.long_name ?? n.short_name ?? formatNodeId(n.node_id);
        const elm = buildNodeElement({ name, role: n.role, isGateway: false, dark, showLabel: true, estimated: true });
        const radiusKm = n.confidence_radius_m / 1000;
        const html =
          `<div style="font:12px 'Segoe UI',system-ui;min-width:170px;background:${popBg};color:${popText};` +
          `border:1px solid ${est};border-radius:8px;padding:8px 10px;box-shadow:0 4px 14px rgba(0,0,0,.5)">` +
          `<div style="font-weight:700;font-size:11px;letter-spacing:.06em;color:${est}">ESTIMATED</div>` +
          `<div style="font-weight:700">${esc(name)}</div>` +
          `<div style="color:${popFaint};margin-top:3px">± ${radiusKm >= 1 ? radiusKm.toFixed(1) + " km" : Math.round(n.confidence_radius_m) + " m"} from ${n.receiver_count} receiver${n.receiver_count === 1 ? "" : "s"}</div>` +
          `</div>`;
        elm.addEventListener("mouseenter", () => popup.setLngLat(c).setHTML(html).addTo(map));
        elm.addEventListener("mouseleave", () => popup.remove());
        elm.addEventListener("click", () => router.push(`/nodes/${n.node_id}`));
        markers.push(new maplibregl.Marker({ element: elm, anchor: "center" }).setLngLat(c).addTo(map));
      }
    });

    return () => { for (const m of markers) m.remove(); map.remove(); };
  }, [nodes, tile, dark, showEst, showAccuracy, showCoverage, rfOnly, nodeType, estimates, router, canClaim]);

  const ctl = (active: boolean) => cn("rounded-md border px-3 py-1 text-[12px] font-medium shadow",
    dark ? "border-line-strong bg-surface text-ink" : "border-neutral-300 bg-white text-neutral-900", !active && "opacity-70");
  const sel = "h-8 rounded-md border border-line bg-raised px-2 text-[12px] text-ink";
  const layerToggles = [
    ...(estimates.length > 0
      ? [
          { key: "est", label: "Estimated positions", checked: showEst, onChange: (v: boolean) => { setShowEst(v); persist("hopwatch_map_estimated", v); } },
          { key: "rf", label: "RF-heard only", checked: rfOnly, onChange: (v: boolean) => { setRfOnly(v); persist("hopwatch_map_rfonly", v); } },
          { key: "acc", label: "Accuracy regions", checked: showAccuracy, onChange: (v: boolean) => { setShowAccuracy(v); persist("hopwatch_map_accuracy", v); } },
        ]
      : []),
    { key: "coverage", label: "Predicted coverage", checked: showCoverage, onChange: (v: boolean) => { setShowCoverage(v); persist("hopwatch_coverage_rings", v); } },
  ];

  function applyFilter(next: Filter) {
    const params = new URLSearchParams();
    if (next.broker) params.set("broker", next.broker);
    if (next.channelId) params.set("channel", next.channelId);
    router.push(`/coverage${params.toString() ? "?" + params : ""}`);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => { const n = !dark; setDark(n); persist("hopwatch_map_dark", n); }} className={ctl(true)}>{dark ? "Dark map" : "Light map"}</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className={sel} value={nodeType} onChange={(e) => { setNodeType(e.target.value); try { localStorage.setItem("hopwatch_map_type", e.target.value); } catch { /* ignore */ } }}>
          {NODE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select className={sel} value={filter.broker ?? ""} onChange={(e) => applyFilter({ ...filter, broker: e.target.value || undefined })}>
          <option value="">all brokers</option>
          {brokers.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select className={sel} value={filter.channelId ?? ""} onChange={(e) => applyFilter({ ...filter, channelId: e.target.value || undefined })}>
          <option value="">all channels</option>
          {channels.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <MapLayersPanel toggles={layerToggles} />
      <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 py-2 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="stat-label">Color = direct gateways</span>
          <div className="flex flex-wrap items-center gap-2 text-ink-mute">
            {COV_KEY.map(([label, color]) => (
              <span key={label} className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full" style={{ background: color }} /> {label}</span>
            ))}
          </div>
        </div>
        <span className="stat-label">Dot size = best signal</span>
        {estimates.length > 0 && (
          <span className="flex items-center gap-1 text-ink-mute"><span className="inline-block h-3 w-3 rounded-full border-2 border-dashed" style={{ borderColor: est(dark) }} /> estimated (non-GPS)</span>
        )}
      </div>
      <div ref={ref} className="h-[70vh] w-full overflow-hidden rounded-xl border border-line" />
    </div>
  );
}

// estColor needs dark at render time for the legend swatch; small local wrapper.
function est(dark: boolean): string { return estColor(dark); }
