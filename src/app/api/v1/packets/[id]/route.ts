import { NextResponse, type NextRequest } from "next/server";
import { getPacketDetail } from "../../../../../db/queries.ts";
import { requireModule } from "../../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "packets");
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const detail = await getPacketDetail(Number(id));
    if (!detail) return NextResponse.json({ error: "unknown packet" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
