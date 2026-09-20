import { NextResponse, type NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "../../../../auth/session.ts";
import { sessionAccess } from "../../../../auth/rbac.ts";
import { getUserPrefs, saveUserPrefs, getDiscordLink, unlinkDiscord } from "../../../../auth/users.ts";
import { effectiveConfig } from "../../../../db/appsettings.ts";
import { distinctBrokers } from "../../../../db/queries.ts";
import { distinctChannels } from "../../../../db/settings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Self-service profile for any signed-in user: Discord link status + personal defaults.
export async function GET(req: NextRequest) {
  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const [prefs, discord, brokers, channels, cfg, access] = await Promise.all([
    getUserPrefs(session.sub), getDiscordLink(session.sub), distinctBrokers(), distinctChannels(), effectiveConfig(),
    sessionAccess(session),
  ]);
  // The stored role, not the one baked into the cookie at login: reporting the cookie's role told a
  // demoted user they were still an admin.
  return NextResponse.json({
    username: session.sub, role: access.roleKey, prefs, discord_linked: discord,
    discord_enabled: cfg.server.auth.discord.enabled, brokers, channels,
  });
}

export async function POST(req: NextRequest) {
  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  if (b.action === "unlink_discord") {
    await unlinkDiscord(session.sub);
    return NextResponse.json({ ok: true });
  }

  try {
    await saveUserPrefs(session.sub, { default_broker: b.default_broker || undefined, default_channel: b.default_channel || undefined });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
