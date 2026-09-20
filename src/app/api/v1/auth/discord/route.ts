import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { effectiveConfig } from "../../../../../db/appsettings.ts";
import { verifySession, SESSION_COOKIE } from "../../../../../auth/session.ts";
import { signState, publicOrigin, OAUTH_COOKIE } from "../../../../../auth/oauth.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function callbackUrl(req: NextRequest, configured: string): string {
  return configured || `${publicOrigin(req)}/api/v1/auth/discord/callback`;
}

// Start the Discord OAuth flow. ?mode=login (default) signs in; ?mode=link (any signed-in
// user) attaches Discord to the current account.
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("mode") === "link" ? "link" : "login";
  const origin = publicOrigin(req);
  const cfg = await effectiveConfig();
  const d = cfg.server.auth.discord;
  if (!d.enabled || !d.client_id) return NextResponse.redirect(new URL("/admin/login?error=discord_disabled", origin));

  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (mode === "link" && !session) {
    return NextResponse.redirect(new URL("/admin/login?error=admin_required", origin));
  }

  const state = signState({ mode, user: session?.sub, nonce: randomBytes(12).toString("hex"), exp: Math.floor(Date.now() / 1000) + 600 });
  const authorize = new URL("https://discord.com/api/oauth2/authorize");
  authorize.searchParams.set("client_id", d.client_id);
  authorize.searchParams.set("redirect_uri", callbackUrl(req, d.redirect_url));
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);

  const res = NextResponse.redirect(authorize.toString());
  res.cookies.set(OAUTH_COOKIE, state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600, secure: process.env.NODE_ENV === "production" });
  return res;
}
