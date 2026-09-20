import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { effectiveConfig } from "../../../../../../db/appsettings.ts";
import { requestNodeReconnect } from "../../../../../../db/settings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Connect now" for the station-node RF receive stream. Admin only.
//
// Web cannot reach the connector directly: it lives in the ingest process, and processes share state
// only through the database (Rule 5). So this writes a request row that the connector picks up on
// the lease poll it already runs every second. It is not a transmit, so the TX arm state does not
// gate it; it only drops and reopens the receive socket.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const cfg = await effectiveConfig();
  if (!cfg.node.host) {
    return NextResponse.json({ error: "no node host set; enter the node IP/hostname first" }, { status: 400 });
  }
  if (!cfg.node.rx_enabled) {
    // The connector is not running at all, so a request row would sit unread. Say so plainly rather
    // than reporting a success that will never happen.
    return NextResponse.json({ error: "RF receive is disabled (node.rx_enabled); enable it first" }, { status: 400 });
  }

  try {
    await requestNodeReconnect(guard.session.sub ?? "admin");
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, note: `reconnecting to ${cfg.node.host}:${cfg.node.port} within ~1s` });
}
