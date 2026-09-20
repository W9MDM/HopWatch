import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../auth/rbac.ts";
import { brokerPresence } from "../../../../db/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-broker presence: HopWatch's own subscriber state, the broker's live $SYS client counts (null
// where the broker hides $SYS), and the observed-gateway roster counts. Read-only, gateways module.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "gateways");
  if (denied) return denied;
  try {
    return NextResponse.json({ brokers: await brokerPresence() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
