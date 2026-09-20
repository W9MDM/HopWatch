"use client";

import { iconSvg, roleColor, HOP_SCALE, hopLabel, EST_COLOR } from "../lib/mapicons.ts";

// Always-visible map key, rendered as a normal block above the map (not a floating
// button). Shows the full hop scale 0..7+, node role icons, link types, and, when the
// map draws them, inferred topology and estimated (non-GPS) positions.
const ROLES: { label: string; role: string | null; gw: boolean }[] = [
  { label: "Gateway", role: null, gw: true },
  { label: "Repeater", role: "REPEATER", gw: false },
  { label: "Router", role: "ROUTER", gw: false },
  { label: "Client", role: "CLIENT", gw: false },
  { label: "Other", role: null, gw: false },
];

export function MapLegend({ showInferred = false, showEstimated = false }: { showInferred?: boolean; showEstimated?: boolean }) {
  return (
    <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 py-2 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="stat-label">Ring = hops away</span>
        <div className="flex items-center gap-1.5 text-ink-mute">
          {HOP_SCALE.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: c }} />
              {i === 7 ? "7+" : hopLabel(i)}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="stat-label">Fill = role</span>
        <div className="flex flex-wrap items-center gap-2 text-ink-mute">
          {ROLES.map((r) => (
            <span key={r.label} className="flex items-center gap-1">
              <span className="inline-grid h-4 w-4 place-items-center" dangerouslySetInnerHTML={{ __html: iconSvg(r.role, r.gw, roleColor(r.role), 14) }} />
              {r.label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="stat-label">Links</span>
        <div className="flex flex-wrap items-center gap-2 text-ink-mute">
          <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-rx-direct" /> direct</span>
          <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-3" style={{ background: "#60a5fa" }} /> neighbor</span>
          <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-rx-relayed" /> relayed</span>
          {showInferred && <span className="flex items-center gap-1"><span className="inline-block h-0 w-3 border-t border-dashed border-ink-faint" /> inferred</span>}
        </div>
      </div>
      {showEstimated && (
        <div className="flex items-center gap-2">
          <span className="stat-label">Estimated</span>
          <span className="flex items-center gap-1 text-ink-mute">
            <span className="inline-block h-3 w-3 rounded-full border-2 border-dashed" style={{ borderColor: EST_COLOR }} />
            non-GPS estimate (dashed ring + confidence circle)
          </span>
        </div>
      )}
    </div>
  );
}
