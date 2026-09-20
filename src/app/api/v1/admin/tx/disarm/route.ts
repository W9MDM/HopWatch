import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { saveOverrides } from "../../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Kill switch: disarm halts the outbox on the worker's next tick. No restart needed.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  await saveOverrides({ tx: { armed: false } });
  return NextResponse.json({ ok: true, armed: false });
}
