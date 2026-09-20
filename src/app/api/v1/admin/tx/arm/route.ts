import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Arm the TX queue. Refuses without a transmit identity (tx.from_node).
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const cfg = await effectiveConfig();
  if (cfg.tx.from_node <= 0) return NextResponse.json({ error: "set tx.from_node before arming" }, { status: 400 });
  // Arming a disabled TX strands the queue: runTxOutbox bails on !tx.enabled before draining, so
  // rows sit at "queued" forever. Enabled is only persisted on Save, so check the saved value.
  if (!cfg.tx.enabled) return NextResponse.json({ error: "enable TX and click Save before arming" }, { status: 400 });
  await saveOverrides({ tx: { armed: true } });
  return NextResponse.json({ ok: true, armed: true });
}
