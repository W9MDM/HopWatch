import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { requestServiceRestart } from "../../../../../../db/settings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ask a background process to restart. This writes a DB request; the target process sees it on
// its next poll and exits, and systemd (Restart=always) relaunches it with the current code. No
// direct IPC, and web never runs systemctl. Only worker/ingest (both run source directly, so a
// restart is all a code update needs); web must be rebuilt + restarted out of band.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as { service?: string } | null;
  const service = b?.service;
  if (service !== "worker" && service !== "ingest") {
    return NextResponse.json({ error: "service must be 'worker' or 'ingest'" }, { status: 400 });
  }
  try {
    await requestServiceRestart(service, guard.session.sub ?? "admin");
    return NextResponse.json({ ok: true, service, note: "restart requested; systemd relaunches within ~5-15s" });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
