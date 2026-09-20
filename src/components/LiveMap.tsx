"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { cn } from "../lib/cn.ts";
import { portName, PORT_NAMES } from "../meshtastic/portnum.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { buildNodeElement, DARK_TILES, DARK_ATTRIB, estColor, NODE_TYPES, matchesNodeType } from "../lib/mapicons.ts";
import { circlePolygon } from "../lib/geo.ts";
import { MapLegend } from "./MapLegend.tsx";
import { MapLayersPanel, AGE_STEPS, withinAge, ageStepForMinutes } from "./MapLayersPanel.tsx";
import { coalesceByPacket, buildRelayResolver, type LiveReception, type LngLat, type Segment } from "../lib/livemap.ts";
import type { LiveMapNode, EstimatedNode } from "../db/queries.ts";
import { subscribeLiveEvent, subscribeLiveState } from "../lib/livesse.ts";

function ageStr(ts: string | null): string {
  if (!ts) return "unknown";
  const s = Math.max(0, (Date.now() - new Date(ts.replace(" ", "T") + "Z").getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export interface LiveMapConfig {
  gatewayRings: boolean;
  audioDefault: boolean;
  maxAnimationsPerSec: number;
  trailDecaySeconds: number;
}
interface MapNodeMeta {
  role: string | null; is_gateway: number; is_relay: number; name: string; shortName: string;
  hw_model: string | null; firmware_version: string | null; last_seen_at: string | null;
  hops: number | null; direct_gateways: number; best_rssi: number | null;
  heard_by?: { gateway_id: number; name: string | null; broker: string | null; status: string; rssi: number | null }[];
}

interface Pulse { seg: Segment; start: number; dur: number; direct: boolean }
interface Ring { pos: LngLat; start: number }

export function LiveMap({ cfg, tile, replayRoute, defaultBroker, defaultChannel, canClaim = false, defaultMaxAgeMin = 0, defaultCenter = null }: { cfg: LiveMapConfig; tile: { url: string; attribution: string; darkUrl?: string; darkAttribution?: string }; replayRoute?: number[]; defaultBroker?: string; defaultChannel?: string; canClaim?: boolean; defaultMaxAgeMin?: number; defaultCenter?: { lat: number; lon: number; zoom: number } | null }) {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const st = useRef({
    map: null as maplibregl.Map | null,
    pos: new Map<number, LngLat>(),
    meta: new Map<number, MapNodeMeta>(),
    relay: (_: number) => null as number | null,
    pending: [] as LiveReception[],
    pulses: [] as Pulse[],
    rings: [] as Ring[],
    lastHeard: new Map<number, number>(),
    markers: new Map<number, { marker: maplibregl.Marker; el: HTMLDivElement }>(),
    estMarkers: [] as maplibregl.Marker[],
    now: 0,
    ready: false,
    lastNodeRefresh: 0,
  });

  const [paused, setPaused] = useState(false);
  const [pausedCount, setPausedCount] = useState(0);
  const [rings, setRings] = useState(cfg.gatewayRings);
  const [speed, setSpeed] = useState(1);
  const [trailSec, setTrailSec] = useState(cfg.trailDecaySeconds);
  const [audio, setAudio] = useState(false);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState({ nodes: 0 });
  const [dark, setDark] = useState(true);
  const [labels, setLabels] = useState(true);
  const [shortNames, setShortNames] = useState(false);
  const [showEst, setShowEst] = useState(true);
  const [showAccuracy, setShowAccuracy] = useState(true);
  const [showInferred, setShowInferred] = useState(true);
  // RF-heard only: hide nodes with no RF reception (direct or relayed) in the last 24h,
  // i.e. nodes present only via their own MQTT uplink. hops is RF-derived, so null = no RF.
  const [rfOnly, setRfOnly] = useState(false);
  const [animations, setAnimations] = useState(true);
  const [ageIdx, setAgeIdx] = useState(ageStepForMinutes(defaultMaxAgeMin));
  const [nodeType, setNodeType] = useState("all");
  const [brokerList, setBrokerList] = useState<string[]>([]);
  const [filters, setFilters] = useState({ port: "", channel: defaultChannel ?? "", gateway: "", broker: defaultBroker ?? "", directOnly: false });
  const persist = (key: string, v: boolean) => { try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* ignore */ } };

  const pausedRef = useRef(paused); pausedRef.current = paused;
  const ringsRef = useRef(rings); ringsRef.current = rings;
  const animationsRef = useRef(animations); animationsRef.current = animations;
  const speedRef = useRef(speed); speedRef.current = speed;
  const trailRef = useRef(trailSec); trailRef.current = trailSec;
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const rfOnlyRef = useRef(rfOnly); rfOnlyRef.current = rfOnly;
  const audioRef = useRef(audio); audioRef.current = audio;
  const actx = useRef<AudioContext | null>(null);

  useEffect(() => {
    const saved = typeof localStorage !== "undefined" && localStorage.getItem("hopwatch_livemap_audio") === "1";
    if (saved) {
      setAudio(true);
      // Browsers block audio until a user gesture, so a reload with audio saved on cannot
      // auto-start. Create the context now and resume on the first interaction so beeps
      // start without the user having to cycle the button.
      try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!actx.current) actx.current = new Ctor();
        const resume = () => {
          void actx.current?.resume();
          window.removeEventListener("pointerdown", resume);
          window.removeEventListener("keydown", resume);
        };
        window.addEventListener("pointerdown", resume);
        window.addEventListener("keydown", resume);
      } catch { /* ignore */ }
    }
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem("hopwatch_map_dark") === "0") setDark(false);
    if (localStorage.getItem("hopwatch_map_labels") === "0") setLabels(false);
    if (localStorage.getItem("hopwatch_map_shortnames") === "1") setShortNames(true);
    if (localStorage.getItem("hopwatch_map_estimated") === "0") setShowEst(false);
    if (localStorage.getItem("hopwatch_map_accuracy") === "0") setShowAccuracy(false);
    if (localStorage.getItem("hopwatch_livemap_inferred") === "0") setShowInferred(false);
    if (localStorage.getItem("hopwatch_livemap_animations") === "0") setAnimations(false);
    if (localStorage.getItem("hopwatch_map_rfonly") === "1") setRfOnly(true);
    // Max-age is not persisted per-browser: the admin-configured default is authoritative and
    // the slider is a live, non-sticky adjustment (see defaultMaxAgeMin).
    const nt = localStorage.getItem("hopwatch_map_type");
    if (nt) setNodeType(nt);
  }, []);

  // Broker/gateway/RF-only filters: show/hide existing node markers, without rebuilding
  // the map (the main effect already applies the same rules at marker-build time).
  useEffect(() => {
    const s = st.current;
    for (const [id, { el }] of s.markers) {
      const m = s.meta.get(id);
      const hb = m?.heard_by ?? [];
      const ok = (!filters.broker || hb.some((h) => h.broker === filters.broker)) &&
                 (!filters.gateway || hb.some((h) => String(h.gateway_id) === filters.gateway)) &&
                 (!rfOnly || m?.hops != null);
      el.style.display = ok ? "" : "none";
    }
  }, [filters.broker, filters.gateway, rfOnly]);

  function beep(rssi: number | null) {
    const ctx = actx.current;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const r = Math.max(-120, Math.min(-30, rssi ?? -100));
    osc.frequency.value = 220 + ((r + 120) / 90) * 900;
    osc.type = "sine";
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.1, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  function toggleAudio() {
    if (!audio) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!actx.current) actx.current = new Ctor();
      void actx.current.resume();
    }
    const next = !audio;
    setAudio(next);
    try { localStorage.setItem("hopwatch_livemap_audio", next ? "1" : "0"); } catch { /* ignore */ }
  }

  useEffect(() => {
    const wrap = wrapRef.current!;
    const s = st.current;

    const map = new maplibregl.Map({
      container: wrap,
      style: { version: 8, sources: { base: { type: "raster", tiles: [dark ? (tile.darkUrl ?? DARK_TILES) : tile.url], tileSize: 256, attribution: dark ? (tile.darkAttribution ?? DARK_ATTRIB) : tile.attribution } }, layers: [{ id: "base", type: "raster", source: "base" }] },
      center: defaultCenter ? [defaultCenter.lon, defaultCenter.lat] : [0, 20],
      zoom: defaultCenter ? defaultCenter.zoom : 1.5,
      attributionControl: { compact: true },
    });
    s.map = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const empty = { type: "FeatureCollection" as const, features: [] };

    Promise.all([
      fetch(`/api/v1/livemap${filters.broker ? `?broker=${encodeURIComponent(filters.broker)}` : ""}`).then((r) => r.json()),
      new Promise<void>((res) => map.on("load", () => res())),
    ]).then(([data]: [{ nodes: LiveMapNode[]; inferred: { a: number; b: number }[]; brokers?: string[]; estimates?: EstimatedNode[] }, void]) => {
      for (const n of data.nodes) {
        s.pos.set(n.node_id, [n.longitude, n.latitude]);
        s.meta.set(n.node_id, {
          role: n.role, is_gateway: n.is_gateway, is_relay: n.is_relay,
          name: n.long_name ?? n.short_name ?? formatNodeId(n.node_id),
          shortName: n.short_name ?? n.long_name ?? formatNodeId(n.node_id),
          hw_model: n.hw_model, firmware_version: n.firmware_version, last_seen_at: n.last_seen_at,
          hops: n.hops, direct_gateways: n.direct_gateways, best_rssi: n.best_rssi, heard_by: n.heard_by,
        });
      }
      s.relay = buildRelayResolver(data.nodes.map((n) => ({ id: n.node_id })));
      setStats({ nodes: data.nodes.length });
      setBrokerList(data.brokers ?? []);

      // Inferred topology underlay (dashed, dim).
      const inferredFeatures = data.inferred
        .map((e) => {
          const a = s.pos.get(e.a), b = s.pos.get(e.b);
          return a && b ? { type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: [a, b] }, properties: {} } : null;
        })
        .filter(Boolean) as GeoJSON.Feature[];
      map.addSource("inferred", { type: "geojson", data: { type: "FeatureCollection", features: showInferred ? inferredFeatures : [] } });
      map.addLayer({ id: "inferred", type: "line", source: "inferred", paint: { "line-color": dark ? "#9ca3af" : "#334155", "line-width": 1.5, "line-opacity": 0.45, "line-dasharray": [2, 2] } });

      map.addSource("trails", { type: "geojson", data: empty });
      map.addLayer({ id: "trails", type: "line", source: "trails", paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-opacity": ["get", "o"] } });

      // Nodes as Font Awesome HTML markers (role icon + name label; opacity fades by age).
      const nodePopup = new maplibregl.Popup({ closeButton: false, closeOnMove: true, offset: 16, className: "hw-popup" });
      // Keep-open + claim wiring so the hover popup can host a clickable Claim button.
      let closeTimer: ReturnType<typeof setTimeout> | null = null;
      const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } };
      const scheduleClose = () => { cancelClose(); closeTimer = setTimeout(() => nodePopup.remove(), 160); };
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
      const showNodePopup = (lngLat: LngLat, html: string, claim?: { id: number; name: string; lat: number; lng: number; role: string | null }) => {
        cancelClose();
        nodePopup.setLngLat(lngLat).setHTML(html).addTo(map);
        const pe = nodePopup.getElement();
        if (pe) {
          if (!pe.dataset.hwWired) { pe.dataset.hwWired = "1"; pe.addEventListener("mouseenter", cancelClose); pe.addEventListener("mouseleave", scheduleClose); }
          if (claim) wireClaim(pe, claim);
        }
      };
      const popBg = dark ? "#141412" : "#ffffff";
      const popBorder = dark ? "#272725" : "#d4d4d4";
      const popText = dark ? "#f2f1ed" : "#0b0b0a";
      const popFaint = dark ? "#8a8a84" : "#6f6e67";
      const escp = (t: string) => t.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
      const prow = (label: string, val: string) => `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:${popFaint}">${label}</span><span style="color:${popText}">${val}</span></div>`;
      const heardRows = (entries: MapNodeMeta["heard_by"]): string => {
        if (!entries || entries.length === 0) return "";
        const rows = entries.map((e) => {
          const gw = e.name ? escp(e.name) : formatNodeId(e.gateway_id);
          // broker "node" = our own station receiver heard this over the air (no MQTT
          // involved); every other entry is an RF hearing reported through that broker.
          const via = e.broker === "node"
            ? ` <span style="color:#4ade80;font-weight:600">via RF (station)</span>`
            : e.broker ? ` <span style="color:${popFaint}">via ${escp(e.broker)}</span>` : "";
          const sig = e.rssi != null ? ` ${e.rssi}dBm` : "";
          // Non-color encoding (accessibility): direct = filled dot, relayed = hollow ring.
          const dot = e.status === "direct" ? "#4ade80" : "#fbbf24";
          const mark = e.status === "direct" ? `background:${dot}` : `border:1.5px solid ${dot};box-sizing:border-box`;
          return `<div style="display:flex;align-items:center;gap:5px"><span title="${e.status}" style="width:7px;height:7px;border-radius:50%;${mark};flex:none"></span><span style="color:${popText}">${gw}</span>${via}<span style="color:${popFaint};margin-left:auto">${sig}</span></div>`;
        }).join("");
        return `<div style="margin-top:6px;padding-top:5px;border-top:1px solid ${popFaint}33"><div style="color:${popFaint};margin-bottom:2px">Heard over RF by <span style="opacity:.8">(green = direct, yellow = relayed)</span></div>${rows}</div>`;
      };
      const est = estColor(dark);
      const maxMin = AGE_STEPS[ageIdx]!.min;
      for (const [id, p] of s.pos) {
        const m = s.meta.get(id);
        if (!withinAge(m?.last_seen_at ?? null, maxMin)) continue;
        if (!matchesNodeType(m?.role ?? null, !!m?.is_gateway, nodeType)) continue;
        const name = m?.name ?? formatNodeId(id);
        const labelName = shortNames ? (m?.shortName ?? name) : name;
        const elm = buildNodeElement({ name: labelName, role: m?.role ?? null, isGateway: !!m?.is_gateway, hops: m?.hops, dark, showLabel: labels });
        // Broker/gateway filters hide node markers not heard via the selection (heard_by),
        // so picking a broker visibly filters the map, not just the animated pulses.
        const f0 = filtersRef.current;
        const hb0 = m?.heard_by ?? [];
        if ((f0.broker && !hb0.some((h) => h.broker === f0.broker)) || (f0.gateway && !hb0.some((h) => String(h.gateway_id) === f0.gateway)) || (rfOnlyRef.current && m?.hops == null)) elm.style.display = "none";
        const kinds = [m?.is_gateway ? "gateway" : "", m?.is_relay ? "relay" : ""].filter(Boolean).join(" · ");
        const hopsTxt = m?.hops == null || m.hops < 0 ? "hops unknown" : m.hops === 0 ? "direct (0 hops)" : `${m.hops} hop${m.hops === 1 ? "" : "s"} away`;
        const html =
          `<div style="font:12px 'Segoe UI',system-ui;min-width:200px;background:${popBg};color:${popText};` +
          `border:1px solid ${popBorder};border-radius:8px;padding:9px 11px;box-shadow:0 4px 14px rgba(0,0,0,.5)">` +
          `<div style="font-weight:700;font-size:13px">${escp(name)}</div>` +
          `<div style="color:${popFaint};font-family:monospace;font-size:11px;margin-bottom:6px">${formatNodeId(id)}${kinds ? " · " + kinds : ""}</div>` +
          `<div style="display:grid;gap:2px">` +
          prow("Role", escp(m?.role ?? "unknown")) +
          (m?.hw_model ? prow("Hardware", escp(m.hw_model)) : "") +
          (m?.firmware_version ? prow("Firmware", escp(m.firmware_version)) : "") +
          prow("Distance", hopsTxt) +
          prow("Heard by", `${m?.direct_gateways ?? 0} gateway${m?.direct_gateways === 1 ? "" : "s"} direct`) +
          (m?.best_rssi ? prow("Best signal", `${m.best_rssi} dBm`) : "") +
          prow("Last heard", ageStr(m?.last_seen_at ?? null)) +
          `</div>` + heardRows(m?.heard_by) +
          (canClaim ? `<button data-claim="${id}" style="margin-top:8px;width:100%;padding:5px 8px;border-radius:6px;border:1px solid #3f9e63;background:#3f9e63;color:#0b0b0a;font-weight:600;cursor:pointer;font-size:12px">Claim this node</button>` : "") +
          `</div>`;
        const claimInfo = { id, name, lat: p[1], lng: p[0], role: m?.role ?? null };
        elm.addEventListener("mouseenter", () => showNodePopup(p, html, canClaim ? claimInfo : undefined));
        elm.addEventListener("mouseleave", scheduleClose);
        elm.addEventListener("click", () => router.push(`/nodes/${id}`));
        s.markers.set(id, { marker: new maplibregl.Marker({ element: elm, anchor: "center" }).setLngLat(p).addTo(map), el: elm });
        // Seed the fade clock from the snapshot's real last-heard time, so nodes load at an opacity
        // that reflects their actual recency instead of all rendering faded (Infinity age) until a
        // live packet happens to arrive. s.now is the rAF (performance.now) clock, not wall-clock, so
        // map the wall-clock last_seen onto it via the constant offset between the two clocks. Do not
        // clobber a value a live packet may have already set fresher.
        if (!s.lastHeard.has(id)) {
          const seenEpoch = m?.last_seen_at ? Date.parse(m.last_seen_at.replace(" ", "T") + "Z") : NaN;
          if (Number.isFinite(seenEpoch)) s.lastHeard.set(id, performance.now() - (Date.now() - seenEpoch));
        }
      }

      // Estimated (non-GPS) positions: translucent confidence circles + dashed markers.
      const estimates = showEst ? (data.estimates ?? []) : [];
      const estCircles = (showAccuracy ? estimates : []).map((n) => ({
        type: "Feature" as const,
        geometry: { type: "Polygon" as const, coordinates: [circlePolygon({ lat: n.latitude, lon: n.longitude }, n.confidence_radius_m)] },
        properties: {},
      }));
      map.addSource("est-circles", { type: "geojson", data: { type: "FeatureCollection", features: estCircles } });
      map.addLayer({ id: "est-fill", type: "fill", source: "est-circles", paint: { "fill-color": est, "fill-opacity": 0.12 } });
      map.addLayer({ id: "est-outline", type: "line", source: "est-circles", paint: { "line-color": est, "line-width": 1.5, "line-opacity": 0.6, "line-dasharray": [2, 2] } });
      for (const n of estimates) {
        const c: [number, number] = [n.longitude, n.latitude];
        const name = n.long_name ?? n.short_name ?? formatNodeId(n.node_id);
        const labelName = shortNames ? (n.short_name ?? n.long_name ?? formatNodeId(n.node_id)) : name;
        const elm = buildNodeElement({ name: labelName, role: n.role, isGateway: false, dark, showLabel: labels, estimated: true });
        const radiusKm = n.confidence_radius_m / 1000;
        const html =
          `<div style="font:12px 'Segoe UI',system-ui;min-width:180px;background:${popBg};color:${popText};` +
          `border:1px solid ${est};border-radius:8px;padding:9px 11px;box-shadow:0 4px 14px rgba(0,0,0,.5)">` +
          `<div style="font-weight:700;font-size:11px;letter-spacing:.06em;color:${est}">ESTIMATED POSITION</div>` +
          `<div style="font-weight:700;font-size:13px;margin-top:2px">${escp(name)}</div>` +
          `<div style="color:${popFaint};font-family:monospace;font-size:11px;margin-bottom:6px">${formatNodeId(n.node_id)}</div>` +
          `<div style="display:grid;gap:2px">` +
          prow("From", `${n.receiver_count} receiver${n.receiver_count === 1 ? "" : "s"}`) +
          prow("Confidence", `± ${radiusKm >= 1 ? radiusKm.toFixed(1) + " km" : Math.round(n.confidence_radius_m) + " m"}`) +
          (n.possibly_mobile ? prow("Note", "possibly mobile") : "") +
          `</div><div style="color:${popFaint};margin-top:5px;font-size:11px">Inferred from RSSI, not GPS.</div></div>`;
        elm.addEventListener("mouseenter", () => nodePopup.setLngLat(c).setHTML(html).addTo(map));
        elm.addEventListener("mouseleave", () => nodePopup.remove());
        elm.addEventListener("click", () => router.push(`/nodes/${n.node_id}`));
        s.estMarkers.push(new maplibregl.Marker({ element: elm, anchor: "center" }).setLngLat(c).addTo(map));
      }

      map.addSource("rings", { type: "geojson", data: empty });
      map.addLayer({ id: "rings", type: "circle", source: "rings", paint: { "circle-radius": ["get", "r"], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#f04747", "circle-stroke-width": 1.5, "circle-stroke-opacity": ["get", "o"] } });

      map.addSource("pulses", { type: "geojson", data: empty });
      map.addLayer({ id: "pulses", type: "circle", source: "pulses", paint: { "circle-radius": 3.5, "circle-color": ["get", "color"], "circle-opacity": ["get", "o"] } });

      // Only auto-jump to the first node when no default center is configured; otherwise the
      // admin-chosen center stands.
      const first = data.nodes[0];
      if (first && !defaultCenter) map.easeTo({ center: [first.longitude, first.latitude], zoom: 8, duration: 0 });

      const infPopup = new maplibregl.Popup({ closeButton: false, closeOnMove: true });
      map.on("mouseenter", "inferred", (e) => { if (e.lngLat) infPopup.setLngLat(e.lngLat).setText("inferred RF topology (not this packet's path)").addTo(map); });
      map.on("mouseleave", "inferred", () => infPopup.remove());

      s.ready = true;
      if (replayRoute && replayRoute.length > 1) animateRoute(replayRoute);
      refreshNodes();
    });

    // Traceroute node-by-node animation (recorded order; honest).
    const animateRoute = (route: number[]) => {
      const step = 600 / Math.max(0.25, speedRef.current);
      route.forEach((id, i) => {
        if (i === 0) return;
        const a = s.pos.get(route[i - 1]!), b = s.pos.get(id);
        if (a && b) s.pulses.push({ seg: { from: a, to: b, observed: true, label: "traceroute" }, start: s.now + i * step, dur: step, direct: false });
      });
    };

    const refreshNodes = () => {
      const now = s.now;
      for (const [id, { el }] of s.markers) {
        const heard = s.lastHeard.get(id);
        const ageMin = heard ? (now - heard) / 60000 : Infinity;
        el.style.opacity = String(ageMin < 5 ? 1 : ageMin < 60 ? 0.75 : ageMin < 1440 ? 0.45 : 0.2);
      }
    };

    // Flush coalesced packets from the buffer (10 Hz), capped per second.
    const flush = setInterval(() => {
      if (pausedRef.current || !s.ready || s.pending.length === 0) return;
      const capPerFlush = Math.max(1, Math.floor(cfg.maxAnimationsPerSec / 10));
      const batch = s.pending;
      s.pending = [];
      const packets = coalesceByPacket(batch, { posOf: (id) => s.pos.get(id) ?? null, relayResolver: s.relay }).slice(0, capPerFlush);
      const dur = 1400 / Math.max(0.25, speedRef.current);
      for (const pk of packets) {
        if (pk.sourcePos) s.lastHeard.set(pk.source, s.now);
        for (const gw of pk.gateways) {
          s.lastHeard.set(gw.gatewayId, s.now);
          for (const seg of gw.segments) s.pulses.push({ seg, start: s.now, dur, direct: pk.direct });
          if (ringsRef.current && gw.gatewayPos) s.rings.push({ pos: gw.gatewayPos, start: s.now });
        }
      }
    }, 100);

    const raf = { id: 0 };
    const loop = (ts: number) => {
      s.now = ts;
      const trailMs = trailRef.current * 1000;
      if (s.pulses.length > 600) s.pulses.splice(0, s.pulses.length - 600);
      if (s.rings.length > 300) s.rings.splice(0, s.rings.length - 300);
      s.pulses = s.pulses.filter((p) => ts - p.start < p.dur + trailMs);
      s.rings = s.rings.filter((r) => ts - r.start < 1600);

      if (s.ready && s.map) {
        // Trails: line for each pulse, fading over trailMs after the pulse completes.
        const trailF: GeoJSON.Feature[] = [];
        const pulseF: GeoJSON.Feature[] = [];
        for (const p of animationsRef.current ? s.pulses : []) {
          const t = (ts - p.start) / p.dur;
          const color = p.direct ? "#3f9e63" : "#f04747";
          const fadeAge = ts - p.start - p.dur;
          const o = fadeAge <= 0 ? 0.55 : Math.max(0, 0.55 * (1 - fadeAge / trailMs));
          trailF.push({ type: "Feature", geometry: { type: "LineString", coordinates: [p.seg.from, p.seg.to] }, properties: { color, o } });
          if (t >= 0 && t <= 1) {
            const x = p.seg.from[0] + (p.seg.to[0] - p.seg.from[0]) * t;
            const y = p.seg.from[1] + (p.seg.to[1] - p.seg.from[1]) * t;
            pulseF.push({ type: "Feature", geometry: { type: "Point", coordinates: [x, y] }, properties: { color, o: 1 } });
          }
        }
        const ringF: GeoJSON.Feature[] = s.rings.map((r) => {
          const t = (ts - r.start) / 1600;
          return { type: "Feature", geometry: { type: "Point", coordinates: r.pos }, properties: { r: 5 + t * 26, o: 1 - t } };
        });
        (s.map.getSource("trails") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: trailF });
        (s.map.getSource("pulses") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: pulseF });
        (s.map.getSource("rings") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: ringF });
        if (ts - s.lastNodeRefresh > 1000) { s.lastNodeRefresh = ts; refreshNodes(); }
      }
      raf.id = requestAnimationFrame(loop);
    };
    raf.id = requestAnimationFrame(loop);

    // Live stream.
    const offState = subscribeLiveState(setConnected);
    const offRx = subscribeLiveEvent("reception", (data) => {
      const d = data as LiveReception & { channel: number | null; broker?: string };
      const f = filtersRef.current;
      if (f.port && String(d.port) !== f.port) return;
      if (f.channel && String(d.channel ?? "") !== f.channel) return;
      if (f.gateway && String(d.gateway) !== f.gateway) return;
      if (f.broker && String(d.broker ?? "") !== f.broker) return;
      const direct = d.hopStart != null && d.hopStart === d.hopLimit;
      if (f.directOnly && !direct) return;
      if (pausedRef.current) { setPausedCount((c) => c + 1); return; }
      st.current.pending.push(d);
      if (audioRef.current) beep(d.rssi);
    });
    const offTr = subscribeLiveEvent("traceroute", (data) => {
      const d = data as { from: number; to: number; route: number[] };
      animateRoute([d.from, ...(d.route ?? []), d.to]);
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(wrap);

    return () => {
      clearInterval(flush);
      cancelAnimationFrame(raf.id);
      offRx(); offTr(); offState();
      ro.disconnect();
      for (const { marker } of s.markers.values()) marker.remove();
      s.markers.clear();
      for (const m of s.estMarkers) m.remove();
      s.estMarkers = [];
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, labels, shortNames, showEst, showAccuracy, showInferred, ageIdx, nodeType, canClaim, filters.broker]);

  const gatewayOptions = Array.from(st.current.meta.entries())
    .filter(([, m]) => m.is_gateway)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const tb = (on: boolean) => cn("btn h-8 px-3 text-[13px]", on ? "btn-primary" : "btn-outline");
  const setAge = (i: number) => setAgeIdx(i);
  const liveLayers = [
    { key: "names", label: "Node names", checked: labels, onChange: (v: boolean) => { setLabels(v); persist("hopwatch_map_labels", v); } },
    { key: "shortnames", label: "Short names", checked: shortNames, onChange: (v: boolean) => { setShortNames(v); persist("hopwatch_map_shortnames", v); } },
    { key: "anim", label: "Animations", checked: animations, onChange: (v: boolean) => { setAnimations(v); persist("hopwatch_livemap_animations", v); } },
    { key: "rings", label: "Gateway rings", checked: rings, onChange: (v: boolean) => setRings(v) },
    { key: "inferred", label: "Inferred topology", checked: showInferred, onChange: (v: boolean) => { setShowInferred(v); persist("hopwatch_livemap_inferred", v); } },
    { key: "est", label: "Estimated positions", checked: showEst, onChange: (v: boolean) => { setShowEst(v); persist("hopwatch_map_estimated", v); } },
    { key: "acc", label: "Accuracy regions", checked: showAccuracy, onChange: (v: boolean) => { setShowAccuracy(v); persist("hopwatch_map_accuracy", v); } },
    { key: "rf", label: "RF-heard only", checked: rfOnly, onChange: (v: boolean) => { setRfOnly(v); persist("hopwatch_map_rfonly", v); } },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className={tb(!paused)} onClick={() => { setPaused((p) => !p); setPausedCount(0); }}>
          {paused ? `Paused (${pausedCount})` : "Live"}
        </button>
        <button className={tb(dark)} onClick={() => { const n = !dark; setDark(n); try { localStorage.setItem("hopwatch_map_dark", n ? "1" : "0"); } catch { /* ignore */ } }}>{dark ? "Dark map" : "Light map"}</button>
        <button className={tb(audio)} onClick={toggleAudio}>{audio ? "Audio on" : "Muted"}</button>
        <label className="flex items-center gap-1 text-[12px] text-ink-mute">speed <input type="range" min={0.25} max={4} step={0.25} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} /></label>
        <label className="flex items-center gap-1 text-[12px] text-ink-mute">trail <input type="range" min={5} max={120} step={5} value={trailSec} onChange={(e) => setTrailSec(Number(e.target.value))} /></label>
        <span className="ml-auto text-[11px] text-ink-faint">{stats.nodes} nodes</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="h-8 rounded-md border border-line bg-raised px-2 text-[13px] text-ink" value={nodeType} onChange={(e) => { setNodeType(e.target.value); try { localStorage.setItem("hopwatch_map_type", e.target.value); } catch { /* ignore */ } }}>
          {NODE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select className="h-8 rounded-md border border-line bg-raised px-2 text-[13px] text-ink" value={filters.port} onChange={(e) => setFilters({ ...filters, port: e.target.value })}>
          <option value="">all ports</option>
          {Object.entries(PORT_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="h-8 w-24 rounded-md border border-line bg-raised px-2 text-[13px] text-ink" placeholder="channel" value={filters.channel} onChange={(e) => setFilters({ ...filters, channel: e.target.value })} />
        <select className="h-8 rounded-md border border-line bg-raised px-2 text-[13px] text-ink" value={filters.gateway} onChange={(e) => setFilters({ ...filters, gateway: e.target.value })}>
          <option value="">all gateways</option>
          {gatewayOptions.map(([id, m]) => <option key={id} value={id}>{m.name}</option>)}
        </select>
        <select className="h-8 rounded-md border border-line bg-raised px-2 text-[13px] text-ink" value={filters.broker} onChange={(e) => setFilters({ ...filters, broker: e.target.value })}>
          <option value="">all brokers</option>
          {brokerList.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <label className="flex items-center gap-1 text-[13px] text-ink-mute"><input type="checkbox" checked={filters.directOnly} onChange={(e) => setFilters({ ...filters, directOnly: e.target.checked })} /> direct only</label>
      </div>

      <MapLayersPanel toggles={liveLayers} maxAge={{ steps: AGE_STEPS, index: ageIdx, onChange: setAge }} />
      <MapLegend showInferred showEstimated />
      <div className="relative">
        <div ref={wrapRef} className="h-[74vh] w-full overflow-hidden rounded-xl border border-line bg-canvas" />
        {!connected && (
          <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-accent/40 bg-surface px-3 py-1 text-[12px] text-accent-strong shadow-xl shadow-black/50">
            Stream disconnected, reconnecting…
          </div>
        )}
      </div>
      <p className="text-[11px] text-ink-faint">
        Pulses animate observed receptions only: source to (resolved relay to) gateway. One packet heard by N gateways shows one source and N rings. Dashed lines are inferred RF topology, not this packet's path.
      </p>
    </div>
  );
}
