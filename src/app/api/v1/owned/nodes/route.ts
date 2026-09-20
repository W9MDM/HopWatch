import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../../auth/rbac.ts";
import { requestActor } from "../../../../../auth/actor.ts";
import { listOwnedNodes, createOwnedNode, editableNodeIds, ownerLabelFor, type OwnedNodeInput } from "../../../../../db/ownednodes.ts";
import { query } from "../../../../../db/client.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const actor = await requestActor(req);
  const nodes = await listOwnedNodes();
  // Flag which nodes this actor may edit so the UI can show controls without extra calls. Resolved
  // as ONE set rather than three queries per row: the per-row loop was ~1,200 sequential round
  // trips on a 400-node install, and it grew with the table.
  const editable = actor?.isAdmin ? null : await editableNodeIds(actor);
  for (const n of nodes) n.can_edit = editable === null ? !!actor : editable.has(n.id);
  return NextResponse.json({ nodes, actor: actor ? { id: actor.id, username: actor.username, admin: actor.isAdmin } : null });
}

export async function POST(req: NextRequest) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const actor = await requestActor(req);
  if (!actor) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as (OwnedNodeInput & Record<string, unknown>) | null;
  if (!b || !b.name) return NextResponse.json({ error: "name required" }, { status: 400 });
  // Non-admins may only create nodes owned by themselves or a group they belong to.
  if (!actor.isAdmin) {
    if (b.owner_type === "group") {
      const rows = await query<{ c: number }>(`SELECT COUNT(*) c FROM node_group WHERE id=? AND (created_by=? OR id IN (SELECT group_id FROM node_group_member WHERE user_id=?))`, [b.owner_group_id ?? 0, actor.id, actor.id]);
      if (Number(rows[0]?.c ?? 0) === 0) return NextResponse.json({ error: "not a member of that group" }, { status: 403 });
    } else {
      b.owner_user_id = actor.id; // force self-ownership
    }
  }
  const ownerLabel = await ownerLabelFor(b);
  const id = await createOwnedNode(b, ownerLabel);
  return NextResponse.json({ ok: true, id });
}
