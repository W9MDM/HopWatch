import { NextResponse, type NextRequest } from "next/server";
import type { HopWatchConfig } from "../../../../../config/schema.ts";
import { effectiveConfig } from "../../../../../db/appsettings.ts";
import { verifyDiscordSignature } from "../../../../../lib/discordverify.ts";
import { handleInteraction, type DiscordInteraction } from "../../../../../lib/discordbot.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Discord interactions webhook. This endpoint is intentionally public: Discord (not a signed-in user)
// calls it, and the Ed25519 signature IS the authentication, so it never uses the admin/module guards.
// Discord validates the URL by POSTing a PING and a deliberately-bad signature; we must PONG the first
// and 401 the second, which the verify path below does.
function baseUrlOf(req: NextRequest, cfg: HopWatchConfig): string {
  if (cfg.server.public_url) return cfg.server.public_url.replace(/\/+$/, "");
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || req.nextUrl.host;
  return `${proto}://${host}`;
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get("x-signature-ed25519");
  const ts = req.headers.get("x-signature-timestamp");
  const raw = await req.text(); // raw body is required for signature verification
  const cfg = await effectiveConfig();
  const bot = cfg.discord_bot;
  if (!bot.enabled || !bot.public_key) return new NextResponse("not found", { status: 404 });
  if (!sig || !ts || !verifyDiscordSignature(bot.public_key, sig, ts, raw)) {
    return new NextResponse("invalid request signature", { status: 401 });
  }
  // Reject a replayed (or badly clock-skewed) request: Discord's timestamp is unix seconds, and a
  // legitimate interaction is delivered within seconds. A 5-minute window covers clock skew.
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > 300) {
    return new NextResponse("stale request", { status: 401 });
  }
  let body: DiscordInteraction;
  try { body = JSON.parse(raw) as DiscordInteraction; } catch { return new NextResponse("bad body", { status: 400 }); }
  if (body.type === 1) return NextResponse.json({ type: 1 }); // PING -> PONG
  if (body.type === 2) return NextResponse.json(await handleInteraction(body, cfg, baseUrlOf(req, cfg))); // APPLICATION_COMMAND
  return NextResponse.json({ type: 1 });
}
