import { NextResponse, type NextRequest } from "next/server";
import { requireModule, resolveAccess } from "../../../../auth/rbac.ts";
import { getMapAt } from "../../../../db/queries.ts";
import { effectiveConfig } from "../../../../db/appsettings.ts";
import { fuzzPositions, fuzzDecimalsFor } from "../../../../lib/fuzz.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Map state at an instant, for the history time-slider. ?at=<epoch ms>&window=<minutes>.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "history");
  if (denied) return denied;
  const sp = new URL(req.url).searchParams;
  const atMs = Number(sp.get("at"));
  const at = Number.isFinite(atMs) && atMs > 0 ? new Date(Math.min(atMs, Date.now())) : new Date();
  const window = Math.min(1440, Math.max(1, Number(sp.get("window")) || 60));
  try {
    const nodes = await getMapAt(at, window);
    // Same rows /map serves, so the same privacy policy: these are exact self-reported home
    // coordinates, and `history` is in the default anonymous role, so returning them raw handed an
    // unauthenticated caller precisely what the fuzzed /map deliberately blurs.
    const fuzz = fuzzDecimalsFor(await effectiveConfig(), (await resolveAccess(req)).admin);
    return NextResponse.json({ nodes: fuzzPositions(nodes, fuzz), at: at.getTime(), window });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
