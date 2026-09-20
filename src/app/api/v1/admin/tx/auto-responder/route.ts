import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

// Auto-responder settings. Patches only tx.auto_responder (saveOverrides deep-merges), so it does
// not disturb the rest of the TX config managed on its own tab.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json({ auto_responder: (await effectiveConfig()).tx.auto_responder });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const auto_responder = {
    enabled: !!b.enabled,
    cooldown_s: num(b.cooldown_s, 300, 0, 86400),
    respond_to_dm: b.respond_to_dm !== false,
    respond_to_channel: !!b.respond_to_channel,
    reply_channel: String(b.reply_channel ?? "").slice(0, 64),
    reply_transport: ["match", "both", "fixed"].includes(String(b.reply_transport)) ? b.reply_transport : "match",
    triggers: (Array.isArray(b.triggers) ? b.triggers : [])
      .map((t: { pattern?: unknown; reply?: unknown; reply_mqtt?: unknown; reply_via?: unknown; channels?: unknown }) => ({
        pattern: String(t?.pattern ?? "").slice(0, 128),
        reply: String(t?.reply ?? "").slice(0, 220),
        reply_mqtt: String(t?.reply_mqtt ?? "").slice(0, 220),
        reply_via: t?.reply_via === "dm" || t?.reply_via === "channel" ? t.reply_via : "match",
        channels: (Array.isArray(t?.channels) ? t.channels : [])
          .map((c: unknown) => String(c ?? "").trim().slice(0, 64)).filter(Boolean).slice(0, 10),
      }))
      .filter((t: { pattern: string; reply: string }) => t.pattern && t.reply)
      .slice(0, 20),
    welcome: {
      enabled: !!b.welcome?.enabled,
      within_hops: num(b.welcome?.within_hops, 0, 0, 7),
      reply_via: b.welcome?.reply_via === "dm" ? "dm" : "channel",
      channel: String(b.welcome?.channel ?? "").slice(0, 64),
      message: String(b.welcome?.message ?? "").slice(0, 220),
    },
    spam_nudge: {
      enabled: !!b.spam_nudge?.enabled,
      threshold: num(b.spam_nudge?.threshold, 6, 2, 1000),
      window_minutes: num(b.spam_nudge?.window_minutes, 10, 1, 1440),
      cooldown_minutes: num(b.spam_nudge?.cooldown_minutes, 60, 1, 10080),
      message: String(b.spam_nudge?.message ?? "").slice(0, 220),
    },
  };

  try {
    await saveOverrides({ tx: { auto_responder } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
