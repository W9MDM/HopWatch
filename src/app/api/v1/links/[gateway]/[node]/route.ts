import { NextResponse, type NextRequest } from "next/server";
import { getPairHistory } from "../../../../../../db/queries.ts";
import { requireModule } from "../../../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per (gateway, node) RSSI/SNR history for the pair link charts.
export async function GET(req: NextRequest, ctx: { params: Promise<{ gateway: string; node: string }> }) {
  const denied = await requireModule(req, "gateways");
  if (denied) return denied;
  const { gateway, node } = await ctx.params;
  const hours = req.nextUrl.searchParams.get("hours");
  try {
    const history = await getPairHistory(Number(gateway), Number(node), hours ? Number(hours) : 168);
    return NextResponse.json({ gateway_id: Number(gateway), node_id: Number(node), history });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
