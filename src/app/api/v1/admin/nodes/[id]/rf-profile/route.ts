import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../../auth/guard.ts";
import { query } from "../../../../../../../db/client.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-node RF profile for predicted coverage. Send { height_m, eirp_dbm }; null clears an
// override (falls back to GPS altitude / configured default). Admin only.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const { id } = await ctx.params;
  const nodeId = Number(id);
  if (!nodeId) return NextResponse.json({ error: "invalid node id" }, { status: 400 });
  const b = (await req.json().catch(() => ({}))) as { height_m?: number | null; eirp_dbm?: number | null };
  const num = (v: unknown, min: number, max: number): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  };
  const height = num(b.height_m, 0, 1000);
  const eirp = num(b.eirp_dbm, -20, 60);
  await query(`UPDATE nodes SET rf_height_m=?, rf_eirp_dbm=? WHERE node_id=?`, [height, eirp, nodeId]);
  return NextResponse.json({ ok: true, node_id: nodeId, height_m: height, eirp_dbm: eirp });
}
