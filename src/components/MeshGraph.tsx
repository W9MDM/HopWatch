"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "../lib/cn.ts";
import { subscribeLiveEvent } from "../lib/livesse.ts";
import { HOP_SCALE } from "../lib/mapicons.ts";

interface GNode { id: number; name: string | null; short: string | null; role: string | null; is_gateway: number; degree: number; mqtt_only?: number }
interface GEdge { a: number; b: number; type: "direct" | "relayed" | "traceroute" | "neighbor" }

interface SimNode extends GNode { x: number; y: number; vx: number; vy: number; pulse?: number; ring?: number }
interface SimEdge { s: SimNode; t: SimNode; type: GEdge["type"] }

const ROLE_COLOR: Record<string, string> = {
  CLIENT: "#a4a39c", CLIENT_MUTE: "#6f6e67", ROUTER: "#3f9e63", ROUTER_CLIENT: "#5bb37e", REPEATER: "#e0b43a",
};
const EDGE_COLOR: Record<GEdge["type"], string> = { direct: "#3f9e63", relayed: "#e0b43a", traceroute: "#6f6e67", neighbor: "#5bb37e" };
const roleColor = (r: string | null) => ROLE_COLOR[(r ?? "").toUpperCase()] ?? "#a4a39c";
const fmtId = (n: number) => "!" + (n >>> 0).toString(16).padStart(8, "0");

// Physics params.
const REPULSION = 5000;
const SPRING = 0.02;
const LINK_LEN = 70;
const DAMPING = 0.85;
const CELL = 120;
// Hop-ring layout: each node is pulled to a radius set by its hop distance from the gateway core,
// so every relay hop sits one ring further out (declutters vs a uniform force blob). RING_PULL is
// the radial spring stiffness; RING_SPACING the gap between hop rings.
const RING_SPACING = 96;
const RING_PULL = 0.04;

export function MeshGraph() {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sim = useRef({
    nodes: [] as SimNode[],
    edges: [] as SimEdge[],
    byId: new Map<number, SimNode>(),
    zoom: 1, panX: 0, panY: 0, alpha: 0,
    hover: null as SimNode | null,
    drag: null as SimNode | null,
    panning: false,
    lastX: 0, lastY: 0, downX: 0, downY: 0, moved: false,
    raf: 0, dpr: 1, w: 0, h: 0,
    now: 0,
    maxRing: 0,
    pulses: [] as { s: SimNode; t: SimNode; start: number }[],
    // Sticky highlight from the focus/between pickers (null = no focus). Read by the draw loop.
    highlight: null as Set<SimNode> | null,
    // Node ids filtered out by the hops / min-links / hide-MQTT controls. The draw loop and hit-test
    // skip these, so the view declutters without rebuilding the graph.
    hidden: new Set<number>(),
  });

  const [hours, setHours] = useState(24);
  const [relayed, setRelayed] = useState(false);
  const [traceroute, setTraceroute] = useState(true);
  const [labels, setLabels] = useState(false);
  const [live, setLive] = useState(true);
  const [stats, setStats] = useState({ nodes: 0, edges: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; node: SimNode } | null>(null);
  const [nodeOptions, setNodeOptions] = useState<{ id: number; label: string }[]>([]);
  const [focusId, setFocusId] = useState<number | "">("");
  const [betweenId, setBetweenId] = useState<number | "">("");
  // Declutter filters: max hop-ring to show (7 = all), minimum links a node must have (1 = all, higher
  // hides the leaf ring that makes a big gateway a hairball), and hide nodes only heard over MQTT.
  const [maxHops, setMaxHops] = useState(7);
  const [minLinks, setMinLinks] = useState(1);
  const [hideMqtt, setHideMqtt] = useState(false);
  const [visibleCount, setVisibleCount] = useState(0);
  const [copied, setCopied] = useState(false);
  // Gate the URL-sync effect until the initial hydration from the query string has run, so the
  // first render does not wipe a shared ?focus= link before we have read it.
  const hydrated = useRef(false);
  // Live mirrors of the focus selection, so the post-load fit (a setTimeout inside the fetch effect,
  // which closes over stale state) can tell whether a shared focus link is centering a node.
  const focusRef = useRef<number | "">(focusId); focusRef.current = focusId;
  const betweenRef = useRef<number | "">(betweenId); betweenRef.current = betweenId;
  const [pathNote, setPathNote] = useState<string | null>(null);

  // Fetch + (re)initialize the simulation whenever filters change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ hours: String(hours), relayed: relayed ? "1" : "0", traceroute: traceroute ? "1" : "0" });
    fetch(`/api/v1/graph?${qs}`)
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error ?? "load failed")))))
      .then((data: { nodes: GNode[]; edges: GEdge[] }) => {
        if (cancelled) return;
        const s = sim.current;
        s.nodes = data.nodes.map((n) => ({ ...n, x: 0, y: 0, vx: 0, vy: 0 }));
        s.byId = new Map(s.nodes.map((n) => [n.id, n]));
        s.edges = data.edges
          .map((e) => ({ s: s.byId.get(e.a), t: s.byId.get(e.b), type: e.type }))
          .filter((e): e is SimEdge => !!e.s && !!e.t);

        // Assign a hop ring by BFS depth from the gateway core, so each relay hop lands one ring
        // further out. Seeds are the gateways; with none in view, the most-connected node roots it.
        const adj = new Map<number, number[]>();
        const link = (a: number, b: number) => (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
        for (const e of s.edges) { link(e.s.id, e.t.id); link(e.t.id, e.s.id); }
        let seeds = s.nodes.filter((n) => n.is_gateway);
        if (seeds.length === 0 && s.nodes.length) seeds = [s.nodes.reduce((a, b) => (b.degree > a.degree ? b : a))];
        const depth = new Map<number, number>();
        const queue: number[] = [];
        for (const g of seeds) { depth.set(g.id, 0); queue.push(g.id); }
        for (let qi = 0; qi < queue.length; qi++) {
          const id = queue[qi]!, d = depth.get(id)!;
          for (const nb of adj.get(id) ?? []) if (!depth.has(nb)) { depth.set(nb, d + 1); queue.push(nb); }
        }
        let maxD = 0;
        for (const d of depth.values()) if (d > maxD) maxD = d;
        const orphanRing = maxD + 1; // disconnected nodes park on the outermost ring
        s.maxRing = orphanRing;
        // Seed positions on the node's ring (angle spread by index) so the sim settles fast.
        s.nodes.forEach((n, i) => {
          n.ring = depth.get(n.id) ?? orphanRing;
          const a = (i / Math.max(1, s.nodes.length)) * Math.PI * 2;
          const rr = (n.ring + 1) * RING_SPACING;
          n.x = Math.cos(a) * rr + (Math.random() - 0.5) * 30;
          n.y = Math.sin(a) * rr + (Math.random() - 0.5) * 30;
        });
        s.alpha = 1;
        setStats({ nodes: s.nodes.length, edges: s.edges.length });
        setNodeOptions(
          s.nodes
            .map((n) => ({ id: n.id, label: n.name ?? n.short ?? fmtId(n.id) }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        );
        setLoading(false);
        // Fit the whole graph once it spreads out, UNLESS a shared focus/between link is centering a
        // specific node (the focus effect owns the view then; fitting would zoom back out over it).
        setTimeout(() => { if (!focusRef.current && !betweenRef.current) fitView(); }, 400);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hours, relayed, traceroute]);

  // Canvas sizing + render loop + interactions (mounted once).
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;
    const s = sim.current;

    const resize = () => {
      s.dpr = window.devicePixelRatio || 1;
      s.w = wrap.clientWidth;
      s.h = wrap.clientHeight;
      canvas.width = s.w * s.dpr;
      canvas.height = s.h * s.dpr;
      canvas.style.width = `${s.w}px`;
      canvas.style.height = `${s.h}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const step = () => {
      if (s.alpha < 0.02) return;
      const a = s.alpha;
      // Spatial grid for near-linear repulsion.
      const grid = new Map<string, SimNode[]>();
      const key = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
      for (const n of s.nodes) {
        const k = key(n.x, n.y);
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(n);
      }
      for (const n of s.nodes) {
        let fx = 0, fy = 0;
        const cx = Math.floor(n.x / CELL), cy = Math.floor(n.y / CELL);
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            const bucket = grid.get(`${gx},${gy}`);
            if (!bucket) continue;
            for (const m of bucket) {
              if (m === n) continue;
              let dx = n.x - m.x, dy = n.y - m.y;
              let d2 = dx * dx + dy * dy;
              if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
              if (d2 > CELL * CELL) continue;
              const f = REPULSION / d2;
              const d = Math.sqrt(d2);
              fx += (dx / d) * f;
              fy += (dy / d) * f;
            }
          }
        }
        // Radial pull toward this node's hop ring (replaces plain center gravity): keeps gateways
        // in the middle and pushes each further hop outward into its own ring.
        const targetR = ((n.ring ?? 0) + 1) * RING_SPACING;
        const rr = Math.hypot(n.x, n.y) || 1;
        const rf = (targetR - rr) * RING_PULL;
        fx += (n.x / rr) * rf;
        fy += (n.y / rr) * rf;
        n.vx = (n.vx + fx * a) * DAMPING;
        n.vy = (n.vy + fy * a) * DAMPING;
      }
      for (const e of s.edges) {
        const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - LINK_LEN) * SPRING * a;
        const ux = (dx / d) * f, uy = (dy / d) * f;
        if (e.s !== s.drag) { e.s.vx += ux; e.s.vy += uy; }
        if (e.t !== s.drag) { e.t.vx -= ux; e.t.vy -= uy; }
      }
      for (const n of s.nodes) {
        if (n === s.drag) continue;
        n.vx = Math.max(-30, Math.min(30, n.vx));
        n.vy = Math.max(-30, Math.min(30, n.vy));
        n.x += n.vx;
        n.y += n.vy;
      }
      s.alpha *= 0.99;
    };

    const nodeRadius = (n: SimNode) => 3 + Math.min(9, Math.sqrt(n.degree) * 1.6);
    const sx = (x: number) => x * s.zoom + s.panX;
    const sy = (y: number) => y * s.zoom + s.panY;

    const draw = () => {
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      ctx.clearRect(0, 0, s.w, s.h);
      // Concentric hop-ring guides, one per hop out from the gateway core. Each ring is tinted with
      // its hop-count color from the shared HOP_SCALE (the same palette as the map hop legend) and
      // labeled, so "further out = more hops" reads at a glance. Drawn under everything else.
      if (s.maxRing > 0) {
        ctx.lineWidth = 1.5;
        ctx.font = "11px ui-sans-serif, system-ui";
        ctx.textAlign = "center";
        for (let ring = 0; ring <= s.maxRing; ring++) {
          const color = HOP_SCALE[Math.min(ring, 7)]!;
          const r = (ring + 1) * RING_SPACING * s.zoom;
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.4;
          ctx.beginPath();
          ctx.arc(sx(0), sy(0), r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = color;
          ctx.fillText(ring >= 7 ? "7+ hops" : `${ring} hop${ring === 1 ? "" : "s"}`, sx(0), sy(0) - r - 4);
        }
        ctx.globalAlpha = 1;
      }
      const hoverNeighbors = new Set<SimNode>();
      if (s.hover) {
        hoverNeighbors.add(s.hover);
        for (const e of s.edges) {
          if (e.s === s.hover) hoverNeighbors.add(e.t);
          else if (e.t === s.hover) hoverNeighbors.add(e.s);
        }
      }
      // Active/highlighted set: hover wins, else the sticky focus/between selection.
      const activeSet = s.hover ? hoverNeighbors : s.highlight;
      const strictEdges = !s.hover && !!s.highlight; // focus/between: only intra-set edges
      // Edges
      ctx.lineWidth = 1;
      for (const e of s.edges) {
        if (s.hidden.has(e.s.id) || s.hidden.has(e.t.id)) continue;
        const active = !activeSet
          ? true
          : strictEdges
            ? activeSet.has(e.s) && activeSet.has(e.t)
            : activeSet.has(e.s) || activeSet.has(e.t);
        ctx.strokeStyle = EDGE_COLOR[e.type];
        ctx.globalAlpha = active ? (activeSet ? 0.7 : 0.28) : 0.05;
        ctx.beginPath();
        ctx.moveTo(sx(e.s.x), sy(e.s.y));
        ctx.lineTo(sx(e.t.x), sy(e.t.y));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Live pulses: dots travelling gateway -> node along the link.
      const PULSE_MS = 1200;
      if (s.pulses.length) s.pulses = s.pulses.filter((p) => s.now - p.start < PULSE_MS);
      for (const p of s.pulses) {
        if (s.hidden.has(p.s.id) || s.hidden.has(p.t.id)) continue;
        const prog = (s.now - p.start) / PULSE_MS;
        const x = sx(p.s.x + (p.t.x - p.s.x) * prog);
        const y = sy(p.s.y + (p.t.y - p.s.y) * prog);
        ctx.globalAlpha = 1 - prog;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = "#f04747";
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // Nodes
      for (const n of s.nodes) {
        if (s.hidden.has(n.id)) continue;
        const dim = activeSet && !activeSet.has(n);
        const r = nodeRadius(n);
        const px = sx(n.x), py = sy(n.y);
        ctx.globalAlpha = dim ? 0.25 : 1;
        // Recently-heard flash ring.
        if (n.pulse !== undefined && s.now - n.pulse < 700) {
          const t = (s.now - n.pulse) / 700;
          ctx.beginPath();
          ctx.arc(px, py, r + 3 + t * 10, 0, Math.PI * 2);
          ctx.strokeStyle = "#f04747";
          ctx.globalAlpha = (1 - t) * (dim ? 0.25 : 1);
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.globalAlpha = dim ? 0.25 : 1;
        }
        if (n.is_gateway) {
          ctx.beginPath();
          ctx.arc(px, py, r + 3, 0, Math.PI * 2);
          ctx.strokeStyle = "#d92b2b";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = roleColor(n.role);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#0b0b0a";
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Labels: the toggle always takes effect. Labeling every node on a big mesh while zoomed out
      // is an unreadable soup, so below ~0.5 zoom on a large graph we label only the backbone
      // (gateways + high-degree nodes); zoom in and every node is labeled.
      const showAll = labels;
      const backboneOnly = labels && s.zoom <= 0.5 && s.nodes.length > 120;
      const labelSet = activeSet;
      if (showAll || labelSet) {
        ctx.font = "11px ui-sans-serif, system-ui";
        ctx.fillStyle = "#f2f1ed";
        ctx.textAlign = "center";
        for (const n of s.nodes) {
          if (!showAll && labelSet && !labelSet.has(n)) continue;
          if (showAll && !(labelSet && labelSet.has(n)) && backboneOnly && !n.is_gateway && (n.degree ?? 0) < 6) continue;
          const label = n.name ?? n.short ?? fmtId(n.id);
          ctx.fillText(label, sx(n.x), sy(n.y) - nodeRadius(n) - 4);
        }
      }
    };

    const loop = (ts: number) => {
      s.now = ts;
      step();
      draw();
      s.raf = requestAnimationFrame(loop);
    };
    s.raf = requestAnimationFrame(loop);

    // Interactions
    const worldAt = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left, py = clientY - rect.top;
      return { px, py, wx: (px - s.panX) / s.zoom, wy: (py - s.panY) / s.zoom };
    };
    const nodeAt = (px: number, py: number): SimNode | null => {
      let best: SimNode | null = null, bestD = 14;
      for (const n of s.nodes) {
        if (s.hidden.has(n.id)) continue;
        const dx = sx(n.x) - px, dy = sy(n.y) - py;
        const d = Math.hypot(dx, dy);
        if (d < bestD) { bestD = d; best = n; }
      }
      return best;
    };

    const onDown = (ev: PointerEvent) => {
      const { px, py, wx, wy } = worldAt(ev.clientX, ev.clientY);
      s.downX = px; s.downY = py; s.moved = false; s.lastX = px; s.lastY = py;
      const hit = nodeAt(px, py);
      if (hit) { s.drag = hit; hit.x = wx; hit.y = wy; s.alpha = Math.max(s.alpha, 0.5); }
      else s.panning = true;
      canvas.setPointerCapture(ev.pointerId);
    };
    const onMove = (ev: PointerEvent) => {
      const { px, py, wx, wy } = worldAt(ev.clientX, ev.clientY);
      if (Math.hypot(px - s.downX, py - s.downY) > 4) s.moved = true;
      if (s.drag) {
        s.drag.x = wx; s.drag.y = wy; s.drag.vx = 0; s.drag.vy = 0; s.alpha = Math.max(s.alpha, 0.3);
      } else if (s.panning) {
        s.panX += px - s.lastX; s.panY += py - s.lastY;
      } else {
        const hit = nodeAt(px, py);
        s.hover = hit;
        setHoverInfo(hit ? { x: px, y: py, node: hit } : null);
      }
      s.lastX = px; s.lastY = py;
    };
    const onUp = (ev: PointerEvent) => {
      if (!s.moved && s.drag) router.push(`/nodes/${s.drag.id}`);
      s.drag = null; s.panning = false;
      try { canvas.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      const nz = Math.max(0.1, Math.min(6, s.zoom * factor));
      s.panX = px - ((px - s.panX) / s.zoom) * nz;
      s.panY = py - ((py - s.panY) / s.zoom) * nz;
      s.zoom = nz;
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(s.raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels]);

  // Live pulses from the SSE stream (reuses the dashboard's live feed).
  useEffect(() => {
    if (!live) return;
    const off = subscribeLiveEvent("reception", (data) => {
      {
        const d = data as { from: number; gateway: number };
        const s = sim.current;
        const from = s.byId.get(d.from);
        const gw = s.byId.get(d.gateway);
        if (from) from.pulse = s.now;
        if (from && gw && from !== gw) {
          s.pulses.push({ s: gw, t: from, start: s.now });
          if (s.pulses.length > 300) s.pulses.shift();
        }
      }
    });
    return () => off();
  }, [live]);

  function fitView() {
    fitToNodes(sim.current.nodes);
  }

  function fitToNodes(list: Iterable<SimNode>) {
    const s = sim.current;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
    for (const n of list) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); count++; }
    if (count === 0) return;
    const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    s.zoom = Math.min(6, Math.max(0.1, Math.min(s.w / spanX, s.h / spanY) * (count <= 2 ? 0.35 : 0.75)));
    s.panX = s.w / 2 - ((minX + maxX) / 2) * s.zoom;
    s.panY = s.h / 2 - ((minY + maxY) / 2) * s.zoom;
  }

  // Focus (center on one node + highlight its neighbourhood) or "between" (shortest path
  // through the mesh from A to B, plus the nodes spidering around that path). Recomputed when
  // either picker changes or a fresh graph loads.
  useEffect(() => {
    const s = sim.current;
    setPathNote(null);
    const A = focusId ? s.byId.get(focusId) : null;
    const B = betweenId ? s.byId.get(betweenId) : null;
    if (!A && !B) { s.highlight = null; return; }

    // Undirected adjacency over the current edges.
    const adj = new Map<SimNode, SimNode[]>();
    for (const e of s.edges) {
      (adj.get(e.s) ?? adj.set(e.s, []).get(e.s)!).push(e.t);
      (adj.get(e.t) ?? adj.set(e.t, []).get(e.t)!).push(e.s);
    }

    if (A && B) {
      // BFS shortest path A -> B.
      const prev = new Map<SimNode, SimNode | null>([[A, null]]);
      const q: SimNode[] = [A];
      let hit = false;
      while (q.length) { const u = q.shift()!; if (u === B) { hit = true; break; } for (const v of adj.get(u) ?? []) if (!prev.has(v)) { prev.set(v, u); q.push(v); } }
      const set = new Set<SimNode>();
      if (hit) {
        let cur: SimNode | null = B;
        let hops = 0;
        while (cur) { set.add(cur); cur = prev.get(cur) ?? null; hops++; }
        setPathNote(`${hops - 1} hop(s) between`);
        for (const p of [...set]) for (const v of adj.get(p) ?? []) set.add(v); // spider around the path
      } else {
        set.add(A); set.add(B);
        setPathNote("no path in this window");
      }
      s.highlight = set;
      fitToNodes(set);
    } else {
      const c = (A ?? B)!;
      const set = new Set<SimNode>([c]);
      for (const e of s.edges) { if (e.s === c) set.add(e.t); else if (e.t === c) set.add(e.s); }
      s.highlight = set;
      s.zoom = Math.max(s.zoom, 1.2);
      // Re-center a few times as the ring layout settles (the node keeps moving right after load),
      // so a shared focus link lands with the node in the middle rather than drifting off.
      const recenter = () => { s.panX = s.w / 2 - c.x * s.zoom; s.panY = s.h / 2 - c.y * s.zoom; };
      recenter();
      setTimeout(recenter, 500);
      setTimeout(recenter, 1100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, betweenId, loading]);

  // Hydrate focus/between/hours from the URL on mount, so a shared ?focus=<id> link opens centered
  // on that node (and in the same time window it was captured in, so the node is actually present).
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const f = p.get("focus"), b = p.get("between"), h = p.get("hours");
      if (f && /^\d+$/.test(f)) setFocusId(Number(f));
      if (b && /^\d+$/.test(b)) setBetweenId(Number(b));
      if (h && [6, 24, 168, 720].includes(Number(h))) setHours(Number(h));
      const mh = p.get("maxhops"), ml = p.get("minlinks"), mq = p.get("mqtt");
      if (mh && /^[0-7]$/.test(mh)) setMaxHops(Number(mh));
      if (ml && /^\d+$/.test(ml)) setMinLinks(Math.min(10, Math.max(1, Number(ml))));
      if (mq === "0") setHideMqtt(true);
    } catch { /* no query string */ }
    hydrated.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the URL in sync with the focus/between/hours selection (replaceState, so it never adds
  // history entries or navigates). The address bar is then always a shareable permalink.
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      const p = new URLSearchParams(window.location.search);
      focusId ? p.set("focus", String(focusId)) : p.delete("focus");
      betweenId ? p.set("between", String(betweenId)) : p.delete("between");
      hours !== 24 ? p.set("hours", String(hours)) : p.delete("hours");
      maxHops !== 7 ? p.set("maxhops", String(maxHops)) : p.delete("maxhops");
      minLinks !== 1 ? p.set("minlinks", String(minLinks)) : p.delete("minlinks");
      hideMqtt ? p.set("mqtt", "0") : p.delete("mqtt");
      const qs = p.toString();
      window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    } catch { /* ignore */ }
  }, [focusId, betweenId, hours, maxHops, minLinks, hideMqtt]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked; the address bar still holds the link */ }
  }

  // Recompute which nodes the declutter filters hide, whenever a filter or the graph changes. A node
  // is hidden if it is beyond the hop-ring limit, has fewer than the required links, or is MQTT-only.
  // Gateways are always kept, so a big hub never vanishes out from under its own star.
  useEffect(() => {
    const s = sim.current;
    const hidden = new Set<number>();
    for (const n of s.nodes) {
      if (n.is_gateway) continue;
      const tooFar = maxHops < 7 && (n.ring ?? 0) > maxHops;
      const tooFewLinks = n.degree < minLinks;
      const mqttOnly = hideMqtt && n.mqtt_only === 1;
      if (tooFar || tooFewLinks || mqttOnly) hidden.add(n.id);
    }
    s.hidden = hidden;
    setVisibleCount(s.nodes.length - hidden.size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxHops, minLinks, hideMqtt, loading, stats.nodes]);

  const btn = "btn btn-outline h-8 px-3 text-[13px]";
  const toggle = (on: boolean) => cn("btn h-8 px-3 text-[13px]", on ? "btn-primary" : "btn-outline");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className="h-8 rounded-md border border-line bg-raised px-2 text-[13px] text-ink" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          <option value={6}>6 h</option>
          <option value={24}>24 h</option>
          <option value={168}>7 d</option>
          <option value={720}>30 d</option>
        </select>
        <button className={toggle(traceroute)} onClick={() => setTraceroute((v) => !v)}>Traceroute links</button>
        <button className={toggle(relayed)} onClick={() => setRelayed((v) => !v)}>Relayed links</button>
        <button className={toggle(labels)} onClick={() => setLabels((v) => !v)} title="Show node names. On a large mesh while zoomed out, only the backbone (gateways + hubs) is labeled; zoom in to see every node's label.">Labels</button>
        <button className={toggle(live)} onClick={() => setLive((v) => !v)}>Live</button>
        <button className={btn} onClick={() => fitView()}>Fit</button>
        <button className={btn} onClick={() => { sim.current.alpha = 1; }}>Reheat</button>
        <span className="ml-auto text-[11px] text-ink-faint">{visibleCount < stats.nodes ? `${visibleCount} / ${stats.nodes}` : stats.nodes} nodes · {stats.edges} links</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[12px] text-ink-faint" title="Hide nodes more than this many relay hops out from the gateway core">
          Max hops
          <input type="range" min={0} max={7} value={maxHops} onChange={(e) => setMaxHops(Number(e.target.value))} className="w-28 accent-accent" />
          <span className="w-7 tabular-nums text-ink">{maxHops >= 7 ? "all" : maxHops}</span>
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-faint" title="Hide nodes with fewer than this many links (raise it to drop the single-link leaf ring around a big gateway)">
          Min links
          <input type="range" min={1} max={10} value={minLinks} onChange={(e) => setMinLinks(Number(e.target.value))} className="w-28 accent-accent" />
          <span className="w-7 tabular-nums text-ink">{minLinks}</span>
        </label>
        <button className={toggle(hideMqtt)} onClick={() => setHideMqtt((v) => !v)} title="Hide nodes only heard over MQTT (no RF reception in the window)">Hide MQTT-only</button>
        {(maxHops < 7 || minLinks > 1 || hideMqtt) && (
          <button className={btn} onClick={() => { setMaxHops(7); setMinLinks(1); setHideMqtt(false); }}>Reset filters</button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-ink-faint">Focus</span>
        <select
          className="h-8 max-w-[220px] rounded-md border border-line bg-raised px-2 text-[13px] text-ink"
          value={focusId}
          onChange={(e) => setFocusId(e.target.value ? Number(e.target.value) : "")}
        >
          <option value="">(center a node)</option>
          {nodeOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <span className="text-[12px] text-ink-faint">between</span>
        <select
          className="h-8 max-w-[220px] rounded-md border border-line bg-raised px-2 text-[13px] text-ink"
          value={betweenId}
          onChange={(e) => setBetweenId(e.target.value ? Number(e.target.value) : "")}
        >
          <option value="">(and a second node)</option>
          {nodeOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        {(focusId || betweenId) && (
          <button className={btn} onClick={() => { setFocusId(""); setBetweenId(""); setTimeout(() => fitView(), 0); }}>Clear</button>
        )}
        <button className={btn} onClick={copyLink} title="Copy a shareable link to this view (centered node + time window)">{copied ? "Copied!" : "Copy link"}</button>
        {pathNote && <span className="text-[11px] text-ink-mute">{pathNote}</span>}
      </div>

      <div ref={wrapRef} className="relative h-[72vh] w-full overflow-hidden rounded-xl border border-line bg-canvas">
        <canvas ref={canvasRef} className="block h-full w-full cursor-grab active:cursor-grabbing" />
        {loading && <div className="absolute inset-0 grid place-items-center text-[13px] text-ink-faint">Loading graph…</div>}
        {error && <div className="absolute inset-0 grid place-items-center text-[13px] text-accent-strong">{error}</div>}
        {!loading && !error && stats.nodes === 0 && (
          <div className="absolute inset-0 grid place-items-center text-[13px] text-ink-faint">No links in this window.</div>
        )}
        {hoverInfo && (
          <div className="pointer-events-none absolute z-10 rounded-md border border-line bg-surface px-2 py-1 text-[11px] shadow-xl shadow-black/50"
               style={{ left: hoverInfo.x + 12, top: hoverInfo.y + 12 }}>
            <div className="text-ink">{hoverInfo.node.name ?? hoverInfo.node.short ?? fmtId(hoverInfo.node.id)}</div>
            <div className="text-ink-faint">
              {hoverInfo.node.is_gateway ? "gateway · " : ""}{hoverInfo.node.role ?? "unknown"} · {hoverInfo.node.degree} links
            </div>
          </div>
        )}
        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-3 text-[10px] text-ink-faint">
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-role-router" />router</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-role-repeater" />repeater</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-role-client" />client</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full border border-accent" />gateway</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-rx-direct" />direct</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3" style={{ background: "#5bb37e" }} />neighbor</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-rx-relayed" />relayed</span>
        </div>
      </div>
      <p className="text-[11px] text-ink-faint">Drag nodes to pull the web around, scroll to zoom, drag the background to pan, click a node to open it.</p>
    </div>
  );
}
