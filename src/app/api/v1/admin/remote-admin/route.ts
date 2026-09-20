import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";
import { listRemoteAdmin, forgetRemoteAdmin, markScanned } from "../../../../../db/adminscan.ts";
import { enqueueTx } from "../../../../../db/tx.ts";
import { parseNodeId } from "../../../../../meshtastic/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

// Remote-admin scanner: settings + the persistent record of administrable nodes, plus manual
// probe/forget. Admin only. Probing goes through the armed tx_outbox on the station node.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const cfg = await effectiveConfig();
  return NextResponse.json({ settings: cfg.tx.admin_scanner, rows: await listRemoteAdmin() });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  if (b.op === "settings") {
    const admin_scanner = {
      enabled: !!b.enabled,
      interval_hours: num(b.interval_hours, 24, 1, 8760),
      max_per_run: num(b.max_per_run, 3, 1, 50),
      max_active_age_hours: num(b.max_active_age_hours, 24, 1, 8760),
      reconfirm_hours: num(b.reconfirm_hours, 0, 0, 8760),
    };
    await saveOverrides({ tx: { admin_scanner } });
    return NextResponse.json({ ok: true });
  }

  if (b.op === "forget") {
    const node = parseNodeId(String(b.node ?? ""));
    if (!node) return NextResponse.json({ error: "node required" }, { status: 400 });
    await forgetRemoteAdmin(node);
    return NextResponse.json({ ok: true });
  }

  if (b.op === "scan") {
    const node = parseNodeId(String(b.node ?? ""));
    if (!node) return NextResponse.json({ error: "node required" }, { status: 400 });
    const cfg = await effectiveConfig();
    if (!cfg.tx.enabled) return NextResponse.json({ error: "TX is disabled" }, { status: 409 });
    if (cfg.tx.from_node <= 0) return NextResponse.json({ error: "set tx.from_node first" }, { status: 409 });
    if (!cfg.node.host) return NextResponse.json({ error: "no station node configured" }, { status: 409 });
    const id = await enqueueTx({
      createdBy: `admin-scan:${node}`, transport: "node", kind: "admin_probe",
      channelId: null, toNode: node, fromNode: cfg.tx.from_node, hopLimit: cfg.tx.max_hop_limit, wantAck: false,
    });
    await markScanned(node);
    return NextResponse.json({ ok: true, id, note: "probe queued; a response (if administrable) records within a minute or two" });
  }

  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
