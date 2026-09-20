import { NextResponse, type NextRequest } from "next/server";
import { getLiveMapData } from "../../../../db/queries.ts";
import { effectiveConfig } from "../../../../db/appsettings.ts";
import { requireModule, resolveAccess } from "../../../../auth/rbac.ts";
import { fuzzPositions, fuzzDecimalsFor } from "../../../../lib/fuzz.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "livemap");
  if (denied) return denied;
  let hours = 24;
  let cfg;
  try {
    cfg = await effectiveConfig();
    hours = Number((cfg.livemap as { inference_window_hours?: number }).inference_window_hours ?? 24);
  } catch {
    /* default */
  }
  const broker = req.nextUrl.searchParams.get("broker") || undefined;
  try {
    const data = await getLiveMapData(hours, broker);
    // Location privacy: round coordinates for non-admins when enabled (opt-in). Applies to
    // real node positions and estimated positions alike.
    const fuzz = cfg ? fuzzDecimalsFor(cfg, (await resolveAccess(req)).admin) : null;
    return NextResponse.json({
      ...data,
      nodes: fuzzPositions(data.nodes, fuzz),
      estimates: fuzzPositions(data.estimates, fuzz),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
