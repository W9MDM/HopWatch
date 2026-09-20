import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";
import { BOT_COMMANDS } from "../../../../../lib/discordbot.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Discord bot config: application_id + public_key + guild_id are public and round-trip; bot_token is a
// live credential, encrypted at rest (SECRET_PATHS) and never returned (has_token only, Rule 6).
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await effectiveConfig()).discord_bot;
  return NextResponse.json({
    enabled: b.enabled,
    application_id: b.application_id,
    public_key: b.public_key,
    guild_id: b.guild_id,
    has_token: !!b.bot_token,
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });

  // Register the slash commands with Discord (one-time, or after editing BOT_COMMANDS). Uses the stored
  // token, so save the token first. Guild scope is instant; global can take up to an hour to appear.
  if (body.action === "register") {
    const b = (await effectiveConfig()).discord_bot;
    if (!b.application_id || !b.bot_token) return NextResponse.json({ error: "set the application id and bot token first" }, { status: 400 });
    const url = b.guild_id
      ? `https://discord.com/api/v10/applications/${b.application_id}/guilds/${b.guild_id}/commands`
      : `https://discord.com/api/v10/applications/${b.application_id}/commands`;
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { authorization: `Bot ${b.bot_token}`, "content-type": "application/json" },
        body: JSON.stringify(BOT_COMMANDS),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (!res.ok) return NextResponse.json({ error: `Discord returned ${res.status}: ${text.slice(0, 300)}` }, { status: 502 });
      let count: number = BOT_COMMANDS.length;
      try { count = (JSON.parse(text) as unknown[]).length; } catch { /* keep default */ }
      return NextResponse.json({ ok: true, registered: count, scope: b.guild_id ? "guild" : "global" });
    } catch (e) {
      return NextResponse.json({ error: `register failed: ${(e as Error).message}` }, { status: 502 });
    }
  }

  const discord_bot: Record<string, unknown> = {
    enabled: !!body.enabled,
    application_id: String(body.application_id ?? "").trim(),
    public_key: String(body.public_key ?? "").trim().toLowerCase(),
    guild_id: String(body.guild_id ?? "").trim(),
  };
  // Blank token box keeps the stored (encrypted) one; a non-empty value replaces it.
  if (typeof body.bot_token === "string" && body.bot_token.trim() !== "") discord_bot.bot_token = body.bot_token.trim();

  try {
    await saveOverrides({ discord_bot });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
