import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../../../auth/rbac.ts";
import { requestActor } from "../../../../../../auth/actor.ts";
import { getOwnedNode, updateOwnedNode, deleteOwnedNode, canEditNode, ownerLabelFor, type OwnedNodeInput, type Actor } from "../../../../../../db/ownednodes.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function editable(req: NextRequest, id: number): Promise<{ resp?: NextResponse; actor?: Actor }> {
  const denied = await requireModule(req, "owned");
  if (denied) return { resp: denied };
  const actor = await requestActor(req);
  if (!(await canEditNode(actor, id))) return { resp: NextResponse.json({ error: "not permitted" }, { status: 403 }) };
  return { actor: actor! };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const node = await getOwnedNode(Number((await params).id));
  if (!node) return NextResponse.json({ error: "not found" }, { status: 404 });
  const actor = await requestActor(req);
  node.can_edit = await canEditNode(actor, node.id);
  return NextResponse.json({ node });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const g = await editable(req, id);
  if (g.resp) return g.resp;
  const b = (await req.json().catch(() => null)) as (OwnedNodeInput & Record<string, unknown>) | null;
  if (!b || !b.name) return NextResponse.json({ error: "name required" }, { status: 400 });
  // Non-admins cannot re-assign ownership away from the current owner.
  if (!g.actor!.isAdmin) {
    const cur = await getOwnedNode(id);
    b.owner_type = cur?.owner_type ?? "user";
    b.owner_user_id = cur?.owner_user_id ?? null;
    b.owner_group_id = cur?.owner_group_id ?? null;
  }
  await updateOwnedNode(id, b, await ownerLabelFor(b));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const g = await editable(req, id);
  if (g.resp) return g.resp;
  await deleteOwnedNode(id);
  return NextResponse.json({ ok: true });
}
