import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../../auth/rbac.ts";
import { requestActor } from "../../../../../auth/actor.ts";
import { listGroups, createGroup, deleteGroup } from "../../../../../db/ownednodes.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  return NextResponse.json({ groups: await listGroups() });
}

// Any signed-in user may create a group (they become its creator/owner).
export async function POST(req: NextRequest) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const actor = await requestActor(req);
  if (!actor) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { name?: string; description?: string } | null;
  if (!b?.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  const id = await createGroup(b.name.trim().slice(0, 255), b.description?.trim() || null, actor.id);
  return NextResponse.json({ ok: true, id });
}

// Delete: creator or admin only.
export async function DELETE(req: NextRequest) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const actor = await requestActor(req);
  if (!actor) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const gid = Number(new URL(req.url).searchParams.get("group_id"));
  if (!gid) return NextResponse.json({ error: "group_id required" }, { status: 400 });
  if (!actor.isAdmin) {
    const groups = await listGroups();
    const g = groups.find((x) => x.id === gid);
    if (!g || Number(g.created_by) !== actor.id) return NextResponse.json({ error: "not permitted" }, { status: 403 });
  }
  await deleteGroup(gid);
  return NextResponse.json({ ok: true });
}
