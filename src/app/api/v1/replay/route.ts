import { NextResponse, type NextRequest } from "next/server";
import { getReplayData } from "../../../../db/queries.ts";
import { requireModule, resolveAccess } from "../../../../auth/rbac.ts";
import { effectiveConfig } from "../../../../db/appsettings.ts";
import { fuzzDecimalsFor, roundCoord } from "../../../../lib/fuzz.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "replay");
  if (denied) return denied;
  const hours = req.nextUrl.searchParams.get("hours");
  try {
    const data = await getReplayData(hours ? Number(hours) : 72);
    // The positions map is [lon, lat] tuples, not `latitude`/`longitude` rows, so fuzzPositions
    // does not reach it and the replay animated exact home coordinates for every active node.
    const fuzz = fuzzDecimalsFor(await effectiveConfig(), (await resolveAccess(req)).admin);
    if (fuzz == null) return NextResponse.json(data);
    const positions: Record<number, [number, number]> = {};
    for (const [id, [lon, lat]] of Object.entries(data.positions)) {
      positions[Number(id)] = [roundCoord(lon, fuzz) ?? lon, roundCoord(lat, fuzz) ?? lat];
    }
    return NextResponse.json({ ...data, positions });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
