import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Scheduled automations (templated messages). DB-backed; the worker fires due ones through the
// armed tx_outbox, so they are gated by the TX subsystem like all other sending.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json({ automations: (await effectiveConfig()).automations });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as { automations?: unknown } | null;
  if (!b || !Array.isArray(b.automations)) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const seen = new Set<string>();
  const automations = b.automations.slice(0, 50).map((raw, i) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    let id = String(a.id ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || `auto-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    return {
      id, enabled: a.enabled !== false,
      kind: a.kind === "interval" ? "interval" : "daily",
      at: /^\d{2}:\d{2}$/.test(String(a.at)) ? String(a.at) : "09:00",
      every_minutes: Math.min(10080, Math.max(1, Math.floor(Number(a.every_minutes) || 60))),
      transport: a.transport === "rf" ? "rf" : "mqtt",
      channel: String(a.channel ?? "").slice(0, 64),
      template: String(a.template ?? "").slice(0, 220),
    };
  });
  try {
    await saveOverrides({ automations });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
