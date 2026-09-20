import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../auth/rbac.ts";
import { getLosEndpoint } from "../../../../db/queries.ts";
import { effectiveConfig } from "../../../../db/appsettings.ts";
import { computeLos } from "../../../../lib/los.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// On-demand line-of-sight / terrain profile between any two positioned nodes.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "link-budget");
  if (denied) return denied;
  const sp = new URL(req.url).searchParams;
  const aId = Number(sp.get("a")), bId = Number(sp.get("b"));
  if (!Number.isFinite(aId) || !Number.isFinite(bId) || aId === bId) {
    return NextResponse.json({ error: "two distinct node ids required" }, { status: 400 });
  }
  const [a, b] = await Promise.all([getLosEndpoint(aId >>> 0), getLosEndpoint(bId >>> 0)]);
  if (!a || !b) return NextResponse.json({ error: "both nodes need a known position" }, { status: 400 });

  const lb = ((await effectiveConfig()).rf as Record<string, any>)?.link_budget ?? {};
  const defAnt = Number(lb.antenna_height_m ?? 3);
  const elevationUrl = String(lb.elevation_url ?? "https://api.open-elevation.com/api/v1/lookup") || undefined;
  const aAnt = a.rf_height_m != null ? Number(a.rf_height_m) : defAnt;
  const bAnt = b.rf_height_m != null ? Number(b.rf_height_m) : defAnt;

  const los = await computeLos(
    { lat: a.latitude, lon: a.longitude, antennaM: aAnt },
    { lat: b.latitude, lon: b.longitude, antennaM: bAnt },
    { elevationUrl },
  );
  return NextResponse.json({
    a: { node_id: a.node_id, name: a.name, antenna_m: aAnt },
    b: { node_id: b.node_id, name: b.name, antenna_m: bAnt },
    los,
  });
}
