import { type NextRequest } from "next/server";
import { query } from "../db/client.ts";
import { hashToken } from "./crypto.ts";
import { verifySession, SESSION_COOKIE } from "./session.ts";
import { sessionAccess } from "./rbac.ts";

// Authorize a /api/metrics scrape when server.metrics_public is off. Any real credential
// suffices (this is a read-only scrape, not an admin action): a live signed-in account, or a
// non-revoked API bearer token. Anonymous requests are refused.
export async function metricsAuthorized(req: NextRequest): Promise<boolean> {
  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) {
    // The cookie's signature and expiry are not enough: signSession stamps a 30-day lifetime, so a
    // bare verifySession kept honouring a DELETED user's cookie for the rest of it. This was the one
    // session path where removing an account did not revoke access, while the bearer branch below
    // has always checked revocation. sessionAccess re-reads the account and returns no access for a
    // deleted user (and still tolerates a DB outage, so a blip does not break scraping).
    const access = await sessionAccess(session);
    if (access.admin || access.modules.size > 0) return true;
  }
  const h = req.headers.get("authorization");
  const token = h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
  if (!token) return false;
  try {
    const rows = await query<{ n: number }>(
      `SELECT 1 n FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL LIMIT 1`,
      [hashToken(token)],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}
