import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../../auth/rbac.ts";
import { requestActor } from "../../../../../auth/actor.ts";
import { getClaimStatus, claimNode, releaseNode } from "../../../../../db/ownednodes.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function numParam(req: NextRequest): number | null {
  const n = Number(new URL(req.url).searchParams.get("num_id"));
  return Number.isFinite(n) && n > 0 ? n >>> 0 : null;
}

// Claim status for one observed node (by numeric id). Drives the claim button's initial state.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const num = numParam(req);
  if (!num) return NextResponse.json({ error: "num_id required" }, { status: 400 });
  const actor = await requestActor(req);
  const status = await getClaimStatus(num, actor);
  return NextResponse.json({ ...status, signed_in: !!actor });
}

// Claim a node for the signed-in user (any signed-in / Discord account).
export async function POST(req: NextRequest) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const actor = await requestActor(req);
  if (!actor) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { num_id?: number; name?: string; lat?: number; lng?: number; role?: string };
  const num = b.num_id && Number.isFinite(b.num_id) ? b.num_id >>> 0 : numParam(req);
  if (!num) return NextResponse.json({ error: "num_id required" }, { status: 400 });
  const res = await claimNode(actor, num, { name: b.name, lat: b.lat ?? null, lng: b.lng ?? null, role: b.role });
  if (res.status === "taken") return NextResponse.json({ error: `already claimed by ${res.owner_label ?? "another user"}`, ...res }, { status: 409 });
  return NextResponse.json({ ok: true, ...res });
}

// Release ownership (owner or admin).
export async function DELETE(req: NextRequest) {
  const denied = await requireModule(req, "owned");
  if (denied) return denied;
  const actor = await requestActor(req);
  if (!actor) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const num = numParam(req);
  if (!num) return NextResponse.json({ error: "num_id required" }, { status: 400 });
  const ok = await releaseNode(actor, num);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not permitted" }, { status: 403 });
}
