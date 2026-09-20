import { NextResponse, type NextRequest } from "next/server";
import { getNodeTelemetry, nodeTelemetryMetrics } from "../../../../../../db/queries.ts";
import { requireModule } from "../../../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "nodes");
  if (denied) return denied;
  const { id } = await ctx.params;
  const nodeId = Number(id);
  const sp = req.nextUrl.searchParams;
  const metric = sp.get("metric");
  const hours = sp.get("hours") ? Number(sp.get("hours")) : 168;
  try {
    if (!metric) {
      return NextResponse.json({ metrics: await nodeTelemetryMetrics(nodeId) });
    }
    return NextResponse.json({ metric, hours, points: await getNodeTelemetry(nodeId, metric, hours) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
