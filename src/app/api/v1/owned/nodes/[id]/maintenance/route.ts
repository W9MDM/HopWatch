import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../../../../auth/rbac.ts";
import { requestActor } from "../../../../../../../auth/actor.ts";
import { listMaintenance, addMaintenance, deleteMaintenance, canEditNode } from "../../../../../../../db/ownednodes.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  return NextResponse.json({ maintenance: await listMaintenance(Number((await params).id)) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const id = Number((await params).id);
  const actor = await requestActor(req);
  if (!(await canEditNode(actor, id))) return NextResponse.json({ error: "not permitted" }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { visit_date?: string; notes?: string } | null;
  const when = b?.visit_date ? new Date(b.visit_date) : new Date();
  if (Number.isNaN(when.getTime())) return NextResponse.json({ error: "invalid visit_date" }, { status: 400 });
  await addMaintenance(id, actor!.id, when, b?.notes?.trim() || null);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const id = Number((await params).id);
  const actor = await requestActor(req);
  if (!(await canEditNode(actor, id))) return NextResponse.json({ error: "not permitted" }, { status: 403 });
  const mid = Number(new URL(req.url).searchParams.get("entry_id"));
  if (!mid) return NextResponse.json({ error: "entry_id required" }, { status: 400 });
  await deleteMaintenance(mid, id);
  return NextResponse.json({ ok: true });
}
