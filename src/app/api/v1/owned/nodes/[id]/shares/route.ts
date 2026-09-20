import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../../../../auth/rbac.ts";
import { requestActor } from "../../../../../../../auth/actor.ts";
import { listShares, addShare, removeShare, canEditNode, type Actor } from "../../../../../../../db/ownednodes.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guard(req: NextRequest, id: number): Promise<{ resp?: NextResponse; actor?: Actor }> {
  const denied = await requireModule(req, "owned");
  if (denied) return { resp: denied };
  const actor = await requestActor(req);
  if (!(await canEditNode(actor, id))) return { resp: NextResponse.json({ error: "not permitted" }, { status: 403 }) };
  return { actor: actor! };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const g = await guard(req, id);
  if (g.resp) return g.resp;
  return NextResponse.json({ shares: await listShares(id) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const g = await guard(req, id);
  if (g.resp) return g.resp;
  const b = (await req.json().catch(() => null)) as { user_id?: number; group_id?: number; permission_level?: string } | null;
  if (!b || (!b.user_id && !b.group_id)) return NextResponse.json({ error: "user_id or group_id required" }, { status: 400 });
  const level = b.permission_level === "edit" ? "edit" : "view";
  await addShare(id, { user_id: b.user_id, group_id: b.group_id }, level, g.actor!.id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const g = await guard(req, id);
  if (g.resp) return g.resp;
  const shareId = Number(new URL(req.url).searchParams.get("share_id"));
  if (!shareId) return NextResponse.json({ error: "share_id required" }, { status: 400 });
  await removeShare(shareId, id);
  return NextResponse.json({ ok: true });
}
