"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface GNode { id: number; name: string | null; short: string | null; role: string | null; is_gateway: number; degree: number }
interface GEdge { a: number; b: number; type: "direct" | "relayed" | "traceroute" | "neighbor" }

const ROLE_COLOR: Record<string, string> = {
  CLIENT: "#a4a39c", CLIENT_MUTE: "#6f6e67", ROUTER: "#3f9e63", ROUTER_CLIENT: "#5bb37e", REPEATER: "#e0b43a",
};
const EDGE_COLOR: Record<GEdge["type"], string> = { direct: "#3f9e63", relayed: "#e0b43a", traceroute: "#6f6e67", neighbor: "#5bb37e" };
const roleColor = (r: string | null) => ROLE_COLOR[(r ?? "").toUpperCase()] ?? "#a4a39c";
const fmtId = (n: number) => "!" + (n >>> 0).toString(16).padStart(8, "0");
const labelOf = (n: GNode) => n.short || n.name || fmtId(n.id);

const W = 460, H = 300, CX = W / 2, CY = H / 2, R = 118, MAX = 36;

// A small radial "ego" graph: the node in the middle, the nodes it links to directly arranged
// in a ring. Static (no physics), fed by the graph API's center/depth mode. Click to navigate.
export function NodeEgoGraph({ nodeId }: { nodeId: number }) {
  const router = useRouter();
  const [data, setData] = useState<{ nodes: GNode[]; edges: GEdge[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/graph?center=${nodeId}&depth=1&hours=168&relayed=1`)
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error ?? "load failed")))))
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [nodeId]);

  if (err) return <div className="text-[13px] text-ink-faint">Could not load nearby nodes.</div>;
  if (!data) return <div className="text-[13px] text-ink-faint">Loading nearby nodes…</div>;

  const neighbors = data.nodes.filter((n) => n.id !== nodeId).sort((a, b) => b.degree - a.degree);
  if (neighbors.length === 0) {
    return <div className="text-[13px] text-ink-faint">No direct links heard in the last 7 days.</div>;
  }
  const shown = neighbors.slice(0, MAX);
  const pos = new Map<number, { x: number; y: number }>();
  pos.set(nodeId, { x: CX, y: CY });
  shown.forEach((n, i) => {
    const a = (i / shown.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.id, { x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R });
  });
  const center = data.nodes.find((n) => n.id === nodeId);
  const edges = data.edges.filter((e) => pos.has(e.a) && pos.has(e.b));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 320 }} role="img" aria-label="Nearby nodes graph">
        {edges.map((e, i) => {
          const p = pos.get(e.a)!, q = pos.get(e.b)!;
          return <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={EDGE_COLOR[e.type]} strokeWidth={1} opacity={0.5} />;
        })}
        {shown.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id} className="cursor-pointer" onClick={() => router.push(`/nodes/${n.id}`)}>
              {n.is_gateway ? <circle cx={p.x} cy={p.y} r={7} fill="none" stroke="#d92b2b" strokeWidth={1.5} /> : null}
              <circle cx={p.x} cy={p.y} r={4.5} fill={roleColor(n.role)} stroke="#0b0b0a" strokeWidth={1} />
              <text x={p.x} y={p.y - 9} textAnchor="middle" fontSize={9} fill="#8a8a84">{labelOf(n)}</text>
            </g>
          );
        })}
        {/* center node last so it sits on top */}
        {center?.is_gateway ? <circle cx={CX} cy={CY} r={9} fill="none" stroke="#d92b2b" strokeWidth={2} /> : null}
        <circle cx={CX} cy={CY} r={6.5} fill={roleColor(center?.role ?? null)} stroke="#f2f1ed" strokeWidth={2} />
      </svg>
      <div className="mt-1 flex items-center justify-between text-[11px] text-ink-faint">
        <span>{neighbors.length} directly-linked node(s){neighbors.length > MAX ? `, showing top ${MAX}` : ""}</span>
        <Link className="text-accent hover:underline" href="/graph">Open full graph</Link>
      </div>
    </div>
  );
}
