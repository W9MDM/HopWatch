"use client";

import { useMemo } from "react";

// Lightweight network graph of recent traceroute paths: unique nodes placed on a
// circle, edges for each observed hop. No external graph library.
export function TracerouteGraph({ paths }: { paths: number[][] }) {
  const { nodes, edges } = useMemo(() => {
    const nodeSet = new Set<number>();
    const edgeSet = new Set<string>();
    for (const path of paths) {
      for (let i = 0; i < path.length; i++) {
        nodeSet.add(path[i]!);
        if (i > 0) {
          const a = path[i - 1]!;
          const b = path[i]!;
          edgeSet.add(a < b ? `${a}:${b}` : `${b}:${a}`);
        }
      }
    }
    return { nodes: [...nodeSet], edges: [...edgeSet].map((e) => e.split(":").map(Number) as [number, number]) };
  }, [paths]);

  if (nodes.length === 0) return null;

  const W = 720;
  const H = 420;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 40;
  const pos = new Map<number, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(n, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
  });

  const short = (n: number) => (n >>> 0).toString(16).slice(-4);

  return (
    <div className="card overflow-x-auto">
      <h2 className="eyebrow mb-3">
        <span className="eyebrow-bar" />
        Traceroute graph ({nodes.length} nodes, {edges.length} links)
      </h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {edges.map(([a, b], i) => {
          const pa = pos.get(a)!;
          const pb = pos.get(b)!;
          return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="var(--color-line-strong)" strokeWidth={1} />;
        })}
        {nodes.map((n) => {
          const p = pos.get(n)!;
          return (
            <g key={n}>
              <circle cx={p.x} cy={p.y} r={5} fill="var(--color-rx-direct)" stroke="var(--color-canvas)" strokeWidth={1.5} />
              <text x={p.x} y={p.y - 9} fontSize={9} textAnchor="middle" fill="var(--color-ink-faint)" className="font-mono">
                {short(n)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
