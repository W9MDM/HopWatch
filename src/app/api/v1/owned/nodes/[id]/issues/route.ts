import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../../../../auth/rbac.ts";
import { requestActor } from "../../../../../../../auth/actor.ts";
import { listIssues, createIssue, updateIssueStatus, deleteIssue, canEditNode, type IssueStatus } from "../../../../../../../db/ownednodes.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set(["open", "in_progress", "resolved", "closed"]);

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  return NextResponse.json({ issues: await listIssues(Number((await params).id)) });
}

// Any signed-in user with the module may report an issue (community reporting).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const actor = await requestActor(req);
  if (!actor) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const id = Number((await params).id);
  const b = (await req.json().catch(() => null)) as { issue_type?: string; description?: string } | null;
  if (!b || !b.issue_type?.trim()) return NextResponse.json({ error: "issue_type required" }, { status: 400 });
  await createIssue(id, actor.id, b.issue_type.trim().slice(0, 255), b.description?.trim() || null);
  return NextResponse.json({ ok: true });
}

// Changing status / resolving requires manage rights on the node.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const id = Number((await params).id);
  const actor = await requestActor(req);
  if (!(await canEditNode(actor, id))) return NextResponse.json({ error: "not permitted" }, { status: 403 });
  const b = (await req.json().catch(() => null)) as { issue_id?: number; status?: string } | null;
  if (!b?.issue_id || !b.status || !STATUSES.has(b.status)) return NextResponse.json({ error: "issue_id and valid status required" }, { status: 400 });
  await updateIssueStatus(b.issue_id, id, b.status as IssueStatus);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const id = Number((await params).id);
  const actor = await requestActor(req);
  if (!(await canEditNode(actor, id))) return NextResponse.json({ error: "not permitted" }, { status: 403 });
  const iid = Number(new URL(req.url).searchParams.get("issue_id"));
  if (!iid) return NextResponse.json({ error: "issue_id required" }, { status: 400 });
  await deleteIssue(iid, id);
  return NextResponse.json({ ok: true });
}
