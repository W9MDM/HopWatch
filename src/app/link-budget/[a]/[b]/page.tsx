import { getTerrainLinkBudget } from "../../../../db/queries.ts";
import { formatNodeId } from "../../../../meshtastic/types.ts";
import { DbError } from "../../../../components/DbError.tsx";
import { moduleDenied } from "../../../../components/ModuleGate.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Sample { d_km: number; ground_m: number; los_m: number; fresnel_bottom_m: number }

function CrossSection({ samples }: { samples: Sample[] }) {
  const W = 720;
  const H = 260;
  const pad = 30;
  const xs = samples.map((s) => s.d_km);
  const ys = samples.flatMap((s) => [s.ground_m, s.los_m, s.fresnel_bottom_m]);
  const xMax = Math.max(...xs, 0.001);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yRange = yMax - yMin || 1;
  const px = (d: number) => pad + (d / xMax) * (W - 2 * pad);
  const py = (m: number) => H - pad - ((m - yMin) / yRange) * (H - 2 * pad);

  const groundPts = samples.map((s) => `${px(s.d_km)},${py(s.ground_m)}`).join(" ");
  const groundArea = `${pad},${H - pad} ${groundPts} ${W - pad},${H - pad}`;
  const losPts = samples.map((s) => `${px(s.d_km)},${py(s.los_m)}`).join(" ");
  const fresnelPts = samples.map((s) => `${px(s.d_km)},${py(s.fresnel_bottom_m)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <polygon points={groundArea} fill="var(--color-raised)" stroke="var(--color-line-strong)" strokeWidth={1} />
      <polyline points={fresnelPts} fill="none" stroke="var(--color-gold)" strokeWidth={1} strokeDasharray="4 3" />
      <polyline points={losPts} fill="none" stroke="var(--color-accent-strong)" strokeWidth={1.5} />
      <text x={pad} y={H - 8} fill="var(--color-ink-faint)" fontSize={10}>0 km</text>
      <text x={W - pad - 30} y={H - 8} fill="var(--color-ink-faint)" fontSize={10}>{xMax.toFixed(1)} km</text>
    </svg>
  );
}

export default async function LinkBudgetDetail({ params }: { params: Promise<{ a: string; b: string }> }) {
  const __denied = await moduleDenied("link-budget"); if (__denied) return __denied;
  const { a, b } = await params;
  let lb;
  try {
    lb = await getTerrainLinkBudget(Number(a), Number(b));
  } catch (e) {
    return <DbError error={e} />;
  }
  if (!lb) return <div className="card text-ink-mute">No link-budget result for this pair.</div>;
  const samples: Sample[] | undefined = lb.profile?.samples;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Link budget: {formatNodeId(Number(a))} to {formatNodeId(Number(b))}
        </h1>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="card"><div className="stat-label">Distance</div><div className="stat mt-1 text-base">{lb.distance_km?.toFixed(1) ?? "-"} km</div></div>
        <div className="card"><div className="stat-label">Expected loss</div><div className="stat mt-1 text-base">{lb.expected_path_loss_db?.toFixed(0) ?? "-"} dB</div></div>
        <div className="card"><div className="stat-label">Fresnel clearance</div><div className="stat mt-1 text-base">{lb.fresnel_clearance?.toFixed(0) ?? "-"} m</div></div>
        <div className="card"><div className="stat-label">RSSI deficit</div><div className="stat mt-1 text-base">{lb.deficit_db?.toFixed(0) ?? "-"} dB</div></div>
      </div>
      <div className="card">
        <h2 className="eyebrow mb-3">
          <span className="eyebrow-bar" />
          Terrain cross-section
        </h2>
        {samples && samples.length > 1 ? (
          <>
            <CrossSection samples={samples} />
            <p className="mt-2 text-[11px] text-ink-faint">
              Grey = terrain, red = line of sight, dashed gold = bottom of the first Fresnel zone. Where terrain
              rises above the dashed line the link is obstructed.
            </p>
          </>
        ) : (
          <p className="text-[13px] text-ink-faint">
            No terrain profile stored. Enable <span className="mono">rf.link_budget.terrain</span> to sample elevation.
          </p>
        )}
      </div>
    </div>
  );
}
