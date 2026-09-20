import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { requestServiceUpdate } from "../../../../../../db/settings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ask the host to update HopWatch now: writes an update request row that the
// hopwatch-update timer's check script claims on its next tick (~1 min), then pulls
// the latest code, rebuilds, and restarts all three services. Web never runs git or
// systemctl itself (processes talk only through the DB). Requires the auto-update
// timer from deploy/systemd to be installed; without it the request sits unclaimed.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  try {
    await requestServiceUpdate(guard.session.sub ?? "admin");
    return NextResponse.json({ ok: true, note: "update requested; the updater claims it within ~1 min, then pulls, rebuilds, and restarts (a few minutes)" });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
