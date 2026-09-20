import { NextResponse, type NextRequest } from "next/server";
import { getMapData } from "../../../../db/queries.ts";
import { requireModule, resolveAccess } from "../../../../auth/rbac.ts";
import { effectiveConfig } from "../../../../db/appsettings.ts";
import { fuzzPositions, fuzzDecimalsFor } from "../../../../lib/fuzz.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "map");
  if (denied) return denied;
  try {
    const data = await getMapData();
    // Location privacy: round coordinates for non-admins when enabled (opt-in).
    const fuzz = fuzzDecimalsFor(await effectiveConfig(), (await resolveAccess(req)).admin);
    return NextResponse.json({ ...data, nodes: fuzzPositions(data.nodes, fuzz) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
