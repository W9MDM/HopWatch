import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { hmac } from "./crypto.ts";

// Public origin of the request as the browser sees it. Behind a reverse proxy the Node
// server's own view (req.nextUrl.origin) is the internal bind address (e.g. 0.0.0.0:3030),
// which is NOT a valid OAuth redirect host; the proxy's X-Forwarded-Host/Proto (or the Host
// header) carry the real public URL. The Discord redirect_uri must be built from this so it
// matches what the admin registers, and post-login redirects keep the browser on the public
// host.
export function publicOrigin(req: NextRequest): string {
  const first = (v: string | null) => (v ? v.split(",")[0]!.trim() : "");
  const host = first(req.headers.get("x-forwarded-host")) || first(req.headers.get("host")) || req.nextUrl.host;
  const proto = first(req.headers.get("x-forwarded-proto")) || req.nextUrl.protocol.replace(":", "");
  return `${proto}://${host}`;
}

// Signed OAuth state, carried in both the `state` query param and a short cookie
// (double-submit) to prevent CSRF/replay on the Discord callback.
export interface OAuthState {
  mode: "login" | "link";
  user?: string; // for link mode: the account being linked
  nonce: string;
  exp: number; // epoch seconds
}

export const OAUTH_COOKIE = "hopwatch_oauth";

// Distinct signing domain: a state token must never verify as a session cookie (see auth/crypto.ts).
const OAUTH_DOMAIN = "hopwatch.oauth-state.v1";

export function signState(s: OAuthState): string {
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${body}.${hmac(OAUTH_DOMAIN, body)}`;
}

export function verifyState(v: string | undefined | null): OAuthState | null {
  if (!v) return null;
  const dot = v.lastIndexOf(".");
  if (dot < 0) return null;
  const body = v.slice(0, dot);
  const sig = v.slice(dot + 1);
  const expected = hmac(OAUTH_DOMAIN, body);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
    return s.exp < Math.floor(Date.now() / 1000) ? null : s;
  } catch {
    return null;
  }
}
