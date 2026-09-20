import { NextResponse, type NextRequest } from "next/server";
import { effectiveConfig } from "../../../../../../db/appsettings.ts";
import { signSession, verifySession, SESSION_COOKIE } from "../../../../../../auth/session.ts";
import { verifyState, publicOrigin, OAUTH_COOKIE } from "../../../../../../auth/oauth.ts";
import { findUserByDiscordId, linkDiscord, provisionDiscordUser, getUserIdByUsername } from "../../../../../../auth/users.ts";
import { assignOwnershipByHandle } from "../../../../../../db/ownednodes.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const login = (origin: string, err: string) => NextResponse.redirect(new URL(`/admin/login?error=${err}`, origin));

// Retroactively claim imported nodes whose free-text owner tag matches this Discord user.
async function linkOwnership(username: string, handles: (string | undefined)[]): Promise<void> {
  try {
    const uid = await getUserIdByUsername(username);
    if (uid) await assignOwnershipByHandle(uid, handles);
  } catch { /* non-fatal */ }
}

export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const code = req.nextUrl.searchParams.get("code");
  const stateParam = req.nextUrl.searchParams.get("state");
  const stateCookie = req.cookies.get(OAUTH_COOKIE)?.value;

  // Double-submit + signature check: query state must equal the cookie and verify.
  if (!code || !stateParam || stateParam !== stateCookie) return login(origin, "discord_state");
  const state = verifyState(stateCookie);
  if (!state) return login(origin, "discord_state");

  const cfg = await effectiveConfig();
  const d = cfg.server.auth.discord;
  if (!d.enabled || !d.client_id || !d.client_secret) return login(origin, "discord_disabled");
  const redirectUri = d.redirect_url || `${origin}/api/v1/auth/discord/callback`;
  // When an override redirect is set (e.g. behind a Cloudflare Tunnel where Node sees an
  // internal host), derive the app's public base from it so post-login redirects land on the
  // public host instead of the internal 0.0.0.0:PORT the tunnel forwards to.
  let appOrigin = origin;
  if (d.redirect_url) { try { appOrigin = new URL(d.redirect_url).origin; } catch { /* keep detected origin */ } }

  let profile: { id: string; username?: string; global_name?: string };
  try {
    const tokRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: d.client_id, client_secret: d.client_secret, grant_type: "authorization_code",
        code, redirect_uri: redirectUri,
      }),
    });
    if (!tokRes.ok) throw new Error(`token ${tokRes.status}`);
    const tok = (await tokRes.json()) as { access_token?: string };
    if (!tok.access_token) throw new Error("no access token");
    const meRes = await fetch("https://discord.com/api/users/@me", { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (!meRes.ok) throw new Error(`me ${meRes.status}`);
    profile = await meRes.json();
  } catch (e) {
    console.error(`[discord] ${(e as Error).message}`);
    return login(appOrigin, "discord_failed");
  }
  if (!profile.id) return login(origin, "discord_failed");
  const name = profile.global_name || profile.username || profile.id;

  const clear = (res: NextResponse) => { res.cookies.set(OAUTH_COOKIE, "", { path: "/", maxAge: 0 }); return res; };

  if (state.mode === "link") {
    // Must still be the same signed-in user who started the link (any role, own account).
    const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
    if (!session || !state.user || session.sub !== state.user) {
      return clear(login(appOrigin, "admin_required"));
    }
    const r = await linkDiscord(state.user, profile.id, name);
    if (r.ok) await linkOwnership(state.user, [profile.username, profile.global_name, name, state.user]);
    return clear(NextResponse.redirect(new URL(r.ok ? "/profile?discord=linked" : `/profile?discord=${encodeURIComponent(r.error ?? "error")}`, appOrigin)));
  }

  // login mode: sign in the linked account, or auto-provision a new member account.
  let user = await findUserByDiscordId(profile.id);
  if (!user) {
    if (!d.auto_provision) return clear(login(appOrigin, "discord_unlinked"));
    user = await provisionDiscordUser(profile.id, name);
  }
  // Claim any imported nodes tagged with this user's Discord handle.
  await linkOwnership(user.username, [profile.username, profile.global_name, name, user.username]);
  const ttlSec = cfg.server.auth.session_ttl_hours * 3600;
  const { value, maxAge } = signSession(user.username, user.role, ttlSec);
  const res = NextResponse.redirect(new URL("/", appOrigin));
  res.cookies.set(SESSION_COOKIE, value, { httpOnly: true, sameSite: "lax", path: "/", maxAge, secure: process.env.NODE_ENV === "production" });
  return clear(res);
}
