import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { unlinkDiscord } from "../../../../../auth/users.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  await unlinkDiscord(guard.session.sub);
  return NextResponse.json({ ok: true });
}
