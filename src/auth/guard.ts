import { NextResponse, type NextRequest } from "next/server";
import { query } from "../db/client.ts";
import { hashToken } from "./crypto.ts";
import { sessionAccess } from "./rbac.ts";
import { verifySession, SESSION_COOKIE, type Session } from "./session.ts";

// Read access is enforced per-module by requireModule (src/auth/rbac.ts), which fails
// closed. The old anonymous-read-only requireRead helper was removed to avoid a latent
// fail-open path.

// Admin access: a valid session whose CURRENT (DB-resolved) role carries the admin flag. Async
// because the role is re-read per request so a demotion/revocation takes effect immediately.
export async function requireAdmin(req: NextRequest): Promise<{ session: Session } | NextResponse> {
  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session && (await sessionAccess(session)).admin) return { session };
  return NextResponse.json({ error: "admin required" }, { status: 401 });
}

// Transmit access: a session whose role carries can_tx (admins always do), or an API token
// with can_tx. Anonymous can never send (no session, no token). Returns the actor label
// (for outbox attribution) or a 403 NextResponse.
export async function requireTx(req: NextRequest): Promise<{ actor: string } | NextResponse> {
  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session && (await sessionAccess(session)).canTx) return { actor: session.sub };
  const token = bearer(req);
  if (token) {
    const rows = await query<{ can_tx: number }>(
      `SELECT can_tx FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL`,
      [hashToken(token)],
    );
    if (rows[0] && Number(rows[0].can_tx) === 1) {
      await query(`UPDATE api_tokens SET last_used_at=UTC_TIMESTAMP() WHERE token_hash=?`, [hashToken(token)]).catch(() => {});
      return { actor: "token" };
    }
  }
  return NextResponse.json({ error: "tx not permitted" }, { status: 403 });
}

function bearer(req: NextRequest): string | null {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return null;
}
