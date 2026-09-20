import { NextResponse, type NextRequest } from "next/server";
import { buildEventsIcs } from "../../../lib/ics.ts";
import { effectiveConfig } from "../../../db/appsettings.ts";
import { requireModule } from "../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// .ics subscription feed of recent mesh events. Honors RBAC: served to anyone whose role
// (anonymous by default) grants the records module, which is public in the default config.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "records");
  if (denied) return denied;
  let brand = "HopWatch";
  try {
    brand = (await effectiveConfig()).server.ui.brand_name;
  } catch {
    /* default */
  }
  try {
    const body = await buildEventsIcs(brand);
    return new Response(body, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'inline; filename="hopwatch-events.ics"',
      },
    });
  } catch {
    return NextResponse.json({ error: "feed unavailable" }, { status: 503 });
  }
}
