import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { effectiveConfig } from "../db/appsettings.ts";
import { verifySession, SESSION_COOKIE } from "./session.ts";
import { hashToken } from "./crypto.ts";
import { getUserRole } from "./users.ts";
import { query } from "../db/client.ts";
import { MODULE_KEYS } from "./modules.ts";
import type { Session } from "./session.ts";
import type { HopWatchConfig } from "../config/schema.ts";

export interface Access {
  roleKey: string;
  admin: boolean;
  canTx: boolean;
  modules: Set<string>;
}

/** Zero-privilege access: no admin, no TX, no modules. Returned to truly-anonymous requests
 * when `server.auth.anonymous_read_only` is off, so unauthenticated reads are denied. */
function noAccess(): Access {
  return { roleKey: "none", admin: false, canTx: false, modules: new Set() };
}

function roleToAccess(cfg: HopWatchConfig, roleKey: string): Access {
  const roles = cfg.rbac.roles;
  const r = roles.find((x) => x.key === roleKey) ?? roles.find((x) => x.key === cfg.rbac.anonymous_role);
  const admin = !!r?.admin;
  return {
    roleKey: r?.key ?? roleKey,
    admin,
    canTx: admin || !!r?.can_tx,
    modules: new Set(admin ? MODULE_KEYS : r?.modules ?? []),
  };
}

function bearer(req: NextRequest): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/** Access for a verified session, resolved from the current DB role. Used by the admin/TX guards
 * so they check the authoritative `admin` flag (not a literal role key) and honor revocation. */
export async function sessionAccess(session: Session): Promise<Access> {
  const cfg = await effectiveConfig();
  const key = await sessionRoleKey(cfg, session);
  // Deleted/unknown user: the session is void, so it grants nothing (not member-level access).
  if (key === null) return noAccess();
  return roleToAccess(cfg, key);
}

/** Resolve the access of an API request: admin/viewer session, token role, else anonymous. */
export async function resolveAccess(req: NextRequest): Promise<Access> {
  const cfg = await effectiveConfig();
  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  // The signed-in user's stored role is authoritative and re-read per request (so revocation is
  // immediate); falls back to member_role if the role key no longer exists in config.
  if (session) {
    const key = await sessionRoleKey(cfg, session);
    // null = the account is gone; ignore the cookie and fall through to token/anonymous handling
    // rather than honouring the role string it carries.
    if (key !== null) return roleToAccess(cfg, key);
  }
  const token = bearer(req);
  if (token) {
    const rows = await query<{ role_key: string; can_tx: number }>(
      `SELECT role_key, can_tx FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL`,
      [hashToken(token)],
    );
    if (rows[0]) {
      const a = roleToAccess(cfg, rows[0].role_key || cfg.rbac.token_default_role);
      return { ...a, canTx: a.canTx || Number(rows[0].can_tx) === 1 };
    }
  }
  // No session and no valid token: honor the anonymous-read-only switch. When off, deny.
  if (!cfg.server.auth.anonymous_read_only) return noAccess();
  return roleToAccess(cfg, cfg.rbac.anonymous_role);
}

/** API guard: 403 unless the request's role grants the module. */
export async function requireModule(req: NextRequest, moduleKey: string): Promise<NextResponse | null> {
  const acc = await resolveAccess(req);
  if (acc.admin || acc.modules.has(moduleKey)) return null;
  return NextResponse.json({ error: "forbidden: module not permitted for your role" }, { status: 403 });
}

/** A signed-in user's role key if it still exists in config, else the member role. */
function roleKeyOrMember(cfg: HopWatchConfig, roleKey: string): string {
  return cfg.rbac.roles.some((r) => r.key === roleKey) ? roleKey : cfg.rbac.member_role;
}

/**
 * Resolve a session to its authoritative role key, or null if the session is no longer valid.
 *
 * Uses the CURRENT DB role rather than the role baked into the cookie at login, so a demotion or
 * admin-revocation takes effect on the next request instead of at cookie expiry (up to 30 days).
 *
 * The stored role is the authority, and "no such user" must FAIL CLOSED. Previously any DB miss
 * fell back to the role string inside the signed cookie, so deleting a user did not revoke their
 * access (a deleted admin's cookie still said admin and kept full admin API access) and demoting
 * one did not take effect until the cookie expired, up to 30 days later.
 *
 * Every session is issued by verifyLogin, which requires an admin_users row (it calls
 * ensureAdminSeed first), so failing closed here cannot lock out a bootstrap admin.
 *
 * A genuine DB OUTAGE is distinguished from an authoritative "no row": on a thrown error we keep
 * honouring the cookie's role, so a database blip does not lock every operator out mid-incident.
 */
async function sessionRoleKey(cfg: HopWatchConfig, session: Session): Promise<string | null> {
  try {
    const dbRole = await getUserRole(session.sub);
    if (!dbRole) return null; // user deleted, or never existed: the session is void
    return roleKeyOrMember(cfg, dbRole);
  } catch {
    // DB unavailable (not "user absent"): fall back to the signed cookie rather than locking
    // everyone out during an outage.
    return roleKeyOrMember(cfg, session.role);
  }
}

/** Page-side access (cookie session or anonymous; tokens are API-only). */
export async function pageAccess(): Promise<Access> {
  const cfg = await effectiveConfig();
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (session) {
    const key = await sessionRoleKey(cfg, session);
    if (key !== null) return roleToAccess(cfg, key);
  }
  if (!cfg.server.auth.anonymous_read_only) return noAccess();
  return roleToAccess(cfg, cfg.rbac.anonymous_role);
}
