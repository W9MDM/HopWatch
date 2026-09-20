import { moduleDenied } from "../../components/ModuleGate.tsx";
import { getReplayData } from "../../db/queries.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { pageAccess } from "../../auth/rbac.ts";
import { fuzzDecimalsFor, roundCoord } from "../../lib/fuzz.ts";
import { DbError } from "../../components/DbError.tsx";
import { ReplayMap } from "../../components/ReplayMap.tsx";
import { mapTiles } from "../../lib/maptiles.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ReplayPage() {
  const __denied = await moduleDenied("replay"); if (__denied) return __denied;
  let data;
  try {
    data = await getReplayData(72);
  } catch (e) {
    return <DbError error={e} />;
  }

  // Same policy as /map: the replay plots the same self-reported home coordinates, so it must not
  // be a way around server.privacy.fuzz_positions. The positions map holds [lon, lat] tuples, which
  // fuzzPositions does not reach.
  let fuzz: number | null = null;
  try { fuzz = fuzzDecimalsFor(await effectiveConfig(), (await pageAccess()).admin); } catch { /* exact if config unreadable */ }
  if (fuzz != null) {
    const rounded: Record<number, [number, number]> = {};
    for (const [id, [lon, lat]] of Object.entries(data.positions)) {
      rounded[Number(id)] = [roundCoord(lon, fuzz) ?? lon, roundCoord(lat, fuzz) ?? lat];
    }
    data = { ...data, positions: rounded };
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Mesh replay
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          Last 72 hours, hourly. Built from rollups, so replaying a week never scans raw rows.
        </p>
      </div>
      {data.frames.length === 0 ? (
        <div className="card text-ink-faint">Not enough rollup history yet.</div>
      ) : (
        <ReplayMap frames={data.frames} positions={data.positions} tile={await mapTiles()} />
      )}
    </div>
  );
}
