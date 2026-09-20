import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";
import { listAlertsSent } from "../../../../../db/weatheralerts.ts";
import { enqueueTx } from "../../../../../db/tx.ts";
import { fillAlert } from "../../../../../lib/wxalerts.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SEV = new Set(["Extreme", "Severe", "Moderate", "Minor", "Unknown"]);

// Weather-alert broadcaster settings + a recent-sent log, plus a test send. Admin only. Broadcasts
// go through the armed tx_outbox like everything else.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json({ settings: (await effectiveConfig()).weather_alerts, sent: await listAlertsSent(50) });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  if (b.op === "test") {
    const cfg = await effectiveConfig();
    const wa = cfg.weather_alerts;
    if (!cfg.tx.enabled) return NextResponse.json({ error: "TX is disabled" }, { status: 409 });
    if (cfg.tx.from_node <= 0) return NextResponse.json({ error: "set tx.from_node first" }, { status: 409 });
    const sample = { id: "test", event: "Severe Thunderstorm Warning", severity: "Severe", headline: "Test alert", areaDesc: "Test County", expires: new Date(Date.now() + 3600_000).toISOString(), senderName: "NWS Test" };
    const text = fillAlert(wa.template, sample, cfg.server.local_timezone);
    const id = await enqueueTx({
      createdBy: "wx-alert:test", transport: wa.transport === "mqtt" ? "mqtt" : "node",
      brokerId: wa.transport === "mqtt" ? wa.broker_id : null, kind: "text",
      channelId: wa.channel || null, toNode: null, fromNode: cfg.tx.from_node, payloadText: text, hopLimit: cfg.tx.default_hop_limit, wantAck: false,
    });
    return NextResponse.json({ ok: true, id, preview: text, note: "test queued (needs TX armed + dry-run off to actually send)" });
  }

  const weather_alerts = {
    enabled: !!b.enabled,
    zones: (Array.isArray(b.zones) ? b.zones : []).map((z: unknown) => String(z ?? "").trim().toUpperCase()).filter(Boolean).slice(0, 50),
    min_severity: SEV.has(String(b.min_severity)) ? String(b.min_severity) : "Severe",
    events: (Array.isArray(b.events) ? b.events : []).map((e: unknown) => String(e ?? "").trim()).filter(Boolean).slice(0, 200),
    // Defaults ON: broadcasting every county of a multi-state watch is what the mesh's 220-char
    // budget cannot afford. Absent in an older stored override, so `!== false` keeps it on.
    zones_only: b.zones_only !== false,
    weekly_test: !!b.weekly_test,
    monthly_test: !!b.monthly_test,
    channel: String(b.channel ?? "").slice(0, 64),
    transport: b.transport === "mqtt" ? "mqtt" : "rf",
    broker_id: String(b.broker_id ?? "").slice(0, 64),
    poll_minutes: Math.min(1440, Math.max(1, Math.floor(Number(b.poll_minutes) || 5))),
    template: String(b.template ?? "").slice(0, 220),
  };
  try {
    await saveOverrides({ weather_alerts });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
