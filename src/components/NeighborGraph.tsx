import { formatNodeId } from "../meshtastic/types.ts";

interface Neighbor { other: number; name: string | null; snr: number | null; direction: "reports" | "reported_by" }

// Compact radial RF-neighbor graph: this node at the centre, spokes to each NeighborInfo
// neighbor. Green = this node reports hearing them; amber = they report hearing us. Pure SVG.
export function NeighborGraph({ neighbors }: { neighbors: Neighbor[] }) {
  const list = neighbors.slice(0, 14);
  const W = 340, H = 240, cx = W / 2, cy = H / 2, r = 92;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="RF neighbor graph">
      {list.map((n, i) => {
        const ang = (i / list.length) * Math.PI * 2 - Math.PI / 2;
        const x = cx + r * Math.cos(ang), y = cy + r * Math.sin(ang);
        const color = n.direction === "reports" ? "#4ade80" : "#e0b43a";
        const label = (n.name ?? formatNodeId(n.other)).slice(0, 10);
        const anchor = x < cx - 4 ? "end" : x > cx + 4 ? "start" : "middle";
        return (
          <g key={`${n.other}-${n.direction}`}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke={color} strokeWidth={1.2} strokeOpacity={0.6} />
            {/* The dot + label link to the neighbor's own node page. */}
            <a href={`/nodes/${n.other}`} style={{ cursor: "pointer" }} className="hw-neighbor-link">
              <title>{n.name ?? formatNodeId(n.other)} - open node page</title>
              <circle cx={x} cy={y} r={4} fill={color} />
              <text x={x + (anchor === "end" ? -6 : anchor === "start" ? 6 : 0)} y={y + 3} fontSize="9" fill="#c9c8c2" textAnchor={anchor}>
                {label}{n.snr != null ? ` ${n.snr.toFixed(0)}dB` : ""}
              </text>
            </a>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={7} fill="#f2f1ed" />
      {list.length === 0 && <text x={cx} y={cy + 30} fontSize="11" fill="#8a8a84" textAnchor="middle">No NeighborInfo reports</text>}
    </svg>
  );
}
