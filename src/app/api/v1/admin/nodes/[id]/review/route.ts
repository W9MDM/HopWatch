import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../../auth/guard.ts";
import { query } from "../../../../../../../db/client.ts";
import { toMysqlUtc } from "../../../../../../../lib/time.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Acknowledge a first-heard node from the review feed. Sets reviewed_at.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const { id } = await ctx.params;
  const nodeId = Number(id);
  if (!nodeId) return NextResponse.json({ error: "invalid node id" }, { status: 400 });
  await query(`UPDATE nodes SET reviewed_at=? WHERE node_id=?`, [toMysqlUtc(new Date()), nodeId]);
  return NextResponse.json({ ok: true, node_id: nodeId });
}
