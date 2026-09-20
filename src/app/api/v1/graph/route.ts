import { NextResponse, type NextRequest } from "next/server";
import { getGraphData } from "../../../../db/queries.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "graph");
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  try {
    const centerRaw = sp.get("center");
    const center = centerRaw && Number.isFinite(Number(centerRaw)) ? Number(centerRaw) >>> 0 : undefined;
    const data = await getGraphData({
      hours: sp.get("hours") ? Number(sp.get("hours")) : 24,
      relayed: sp.get("relayed") === "1",
      traceroute: sp.get("traceroute") !== "0",
      center,
      depth: sp.get("depth") ? Number(sp.get("depth")) : undefined,
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
