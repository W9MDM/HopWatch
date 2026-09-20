import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../auth/rbac.ts";
import { listSensorEvents } from "../../../../db/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DETECTION_SENSOR_APP (10) and ALERT_APP (11) events. Gated on the `environment` module, which is
// where the sensor-facing pages live; these are sensor readings, not chat, and are stored apart from
// text_message for the same reason.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "environment");
  if (denied) return denied;
  const sp = new URL(req.url).searchParams;
  try {
    const events = await listSensorEvents({
      kind: sp.get("kind") ?? undefined,
      nodeId: Number(sp.get("node")) || undefined,
      limit: Number(sp.get("limit")) || undefined,
    });
    return NextResponse.json({ events });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
