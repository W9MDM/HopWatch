import { timingSafeEqual } from "node:crypto";
import { hmac } from "./crypto.ts";

// Stateless signed-cookie sessions for admin. Payload is base64url(JSON).signature.
export const SESSION_COOKIE = "hopwatch_session";
// Default session lifetime (30 days). Overridable per login via server.auth.session_ttl_hours;
// the old 12h default logged people out too often for a self-hosted dashboard.
const DEFAULT_TTL_S = 30 * 24 * 3600;

// Binds a session signature to this purpose alone, so a token minted elsewhere with the same
// secret (notably the anonymous-obtainable OAuth state token) cannot be replayed as a session.
const SESSION_DOMAIN = "hopwatch.session.v1";

export interface Session {
  sub: string; // username
  role: string; // an RBAC role key (admin/viewer/member/public/custom); "admin" grants admin APIs
  exp: number; // epoch seconds
}

export function signSession(sub: string, role: string, ttlSec: number = DEFAULT_TTL_S): { value: string; maxAge: number } {
  const maxAge = Math.max(300, Math.floor(ttlSec));
  const payload: Session = { sub, role, exp: Math.floor(Date.now() / 1000) + maxAge };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { value: `${body}.${hmac(SESSION_DOMAIN, body)}`, maxAge };
}

export function verifySession(cookie: string | undefined | null): Session | null {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf(".");
  if (dot < 0) return null;
  const body = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = hmac(SESSION_DOMAIN, body);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
    // Shape check, not just signature: `exp` alone was the only validated field, so any
    // same-secret token carrying an exp (e.g. an OAuth state) parsed into a Session with
    // sub/role undefined, which role resolution then treated as a real signed-in user.
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    if (typeof payload.role !== "string" || !payload.role) return null;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
