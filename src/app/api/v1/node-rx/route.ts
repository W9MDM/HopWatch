import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../auth/rbac.ts";
import { effectiveConfig } from "../../../../db/appsettings.ts";
import { getNodeRxHealth } from "../../../../db/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live state for the navbar RF-node chip so it updates without a full page navigation. Mirrors
// what the layout computes server-side: host + rx_enabled from config, connection from
// broker_health (row 'node', flushed by the ingest daemon).
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "dashboard");
  if (denied) return denied;
  try {
    const cfg = await effectiveConfig();
    const rx = await getNodeRxHealth().catch(() => null);
    return NextResponse.json({
      host: cfg.node.host ?? "",
      rx_enabled: !!cfg.node.rx_enabled,
      connected: rx?.connected ? 1 : 0,
      last_message_at: rx?.last_message_at ?? null,
      updated_at: rx ? true : false,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
