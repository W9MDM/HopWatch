import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { query } from "../../../../../db/client.ts";
import { listMuted } from "../../../../../db/queries.ts";
import { toMysqlUtc } from "../../../../../lib/time.ts";
import { parseNodeId } from "../../../../../meshtastic/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mute is display-only: it sets nodes.mute_hidden so default views hide the node.
// It never sends anything to the mesh.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json({ mute_list: await listMuted() });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const body = (await req.json().catch(() => ({}))) as { node_id?: string | number; reason?: string };
  const nodeId = typeof body.node_id === "string" ? parseNodeId(body.node_id) : Number(body.node_id ?? 0);
  if (!nodeId) return NextResponse.json({ error: "node_id required" }, { status: 400 });
  await query(
    `INSERT INTO mute_list (node_id, reason, added_by, added_at, source) VALUES (?,?,?,?,'admin')
     ON DUPLICATE KEY UPDATE reason=VALUES(reason), added_by=VALUES(added_by)`,
    [nodeId, body.reason ?? null, guard.session.sub, toMysqlUtc(new Date())],
  );
  await query(`UPDATE nodes SET mute_hidden=1 WHERE node_id=?`, [nodeId]);
  return NextResponse.json({ ok: true, node_id: nodeId });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const nodeId = Number(req.nextUrl.searchParams.get("node_id") ?? 0);
  if (!nodeId) return NextResponse.json({ error: "node_id required" }, { status: 400 });
  await query(`DELETE FROM mute_list WHERE node_id=?`, [nodeId]);
  await query(`UPDATE nodes SET mute_hidden=0 WHERE node_id=?`, [nodeId]);
  return NextResponse.json({ ok: true, node_id: nodeId });
}
