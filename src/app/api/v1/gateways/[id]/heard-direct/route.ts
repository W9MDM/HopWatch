import { NextResponse, type NextRequest } from "next/server";
import { getHeardDirect } from "../../../../../../db/queries.ts";
import { toCsv } from "../../../../../../lib/csv.ts";
import { requireModule } from "../../../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/gateways/:id/heard-direct: per-gateway confirmed direct roster.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "gateways");
  if (denied) return denied;
  const { id } = await ctx.params;
  const gatewayId = Number(id);
  if (!Number.isFinite(gatewayId)) {
    return NextResponse.json({ error: "invalid gateway id" }, { status: 400 });
  }
  try {
    const rows = await getHeardDirect(gatewayId);
    if (req.nextUrl.searchParams.get("format") === "csv") {
      return new NextResponse(toCsv(rows), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="heard-direct-${gatewayId}.csv"`,
        },
      });
    }
    return NextResponse.json({ gateway_id: gatewayId, heard_direct: rows });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
