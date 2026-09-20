import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../../auth/guard.ts";
import { query } from "../../../../../../../db/client.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ignore (or restore) a node's location. Ignored nodes are hidden from all maps/coverage so
// a bad or spoofed GPS fix stops skewing the view. Does not affect the node's traffic.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const { id } = await ctx.params;
  const nodeId = Number(id);
  if (!nodeId) return NextResponse.json({ error: "invalid node id" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { ignored?: boolean };
  await query(`UPDATE nodes SET position_ignored=? WHERE node_id=?`, [body.ignored ? 1 : 0, nodeId]);
  return NextResponse.json({ ok: true, node_id: nodeId, ignored: !!body.ignored });
}
