import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../../../../auth/rbac.ts";
import { requestActor } from "../../../../../../../auth/actor.ts";
import { listGroups, listGroupMembers, addGroupMember, removeGroupMember, type Actor } from "../../../../../../../db/ownednodes.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manage rights on a group: its creator or an admin.
async function canManage(req: NextRequest, groupId: number): Promise<{ resp?: NextResponse; actor?: Actor }> {
  const denied = await requireModule(req, "owned");
  if (denied) return { resp: denied };
  const actor = await requestActor(req);
  if (!actor) return { resp: NextResponse.json({ error: "sign in required" }, { status: 401 }) };
  if (!actor.isAdmin) {
    const g = (await listGroups()).find((x) => x.id === groupId);
    if (!g || Number(g.created_by) !== actor.id) return { resp: NextResponse.json({ error: "not permitted" }, { status: 403 }) };
  }
  return { actor };
}

// Group membership names accounts, so it needs a session for the same reason /owned/meta does:
// the "owned" module can be granted to the anonymous role, and module gating alone would then make
// this an unauthenticated read of who holds which group.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  if (!(await requestActor(req))) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  return NextResponse.json({ members: await listGroupMembers(Number((await params).id)) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const g = await canManage(req, id);
  if (g.resp) return g.resp;
  const b = (await req.json().catch(() => null)) as { user_id?: number } | null;
  if (!b?.user_id) return NextResponse.json({ error: "user_id required" }, { status: 400 });
  await addGroupMember(id, b.user_id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const g = await canManage(req, id);
  if (g.resp) return g.resp;
  const userId = Number(new URL(req.url).searchParams.get("user_id"));
  if (!userId) return NextResponse.json({ error: "user_id required" }, { status: 400 });
  await removeGroupMember(id, userId);
  return NextResponse.json({ ok: true });
}
