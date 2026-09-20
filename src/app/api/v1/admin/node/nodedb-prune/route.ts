import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { runNodeDbMaint } from "../../../../../../worker/nodedbmaint.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Prune the station node's on-device NodeDB now (favorite repeaters/routers, remove stale nodes).
// A local node admin action over the stream API (like config write), not an RF transmit. Admin only.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  try {
    const result = await runNodeDbMaint(true); // force: ignore enabled + interval
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
