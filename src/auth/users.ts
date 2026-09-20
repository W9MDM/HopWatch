import { query } from "../db/client.ts";
import { loadConfig } from "../config/load.ts";
import { effectiveConfig } from "../db/appsettings.ts";
import { hashPassword, verifyPassword } from "./crypto.ts";
import { toMysqlUtc } from "../lib/time.ts";

// Seed admin users from config the first time (only when the table is empty), then
// authenticate against the stored scrypt hashes.
export async function ensureAdminSeed(): Promise<void> {
  const countRows = await query<{ c: number }>(`SELECT COUNT(*) c FROM admin_users`);
  if (Number(countRows[0]?.c ?? 0) > 0) return;
  let seed: { username: string; password: string }[] = [];
  try {
    seed = loadConfig().server.auth.admin_users_seed;
  } catch {
    return;
  }
  for (const u of seed) {
    if (!u.username || !u.password) continue;
    await query(
      `INSERT IGNORE INTO admin_users (username, password_hash, role, created_at) VALUES (?,?,?,?)`,
      [u.username, hashPassword(u.password), "admin", toMysqlUtc(new Date())],
    );
  }
}

export interface AdminUserRow {
  id: number; username: string; role: string; created_at: string;
  discord_username: string | null; has_password: number; // 1 = password login, 0 = Discord-only
}

export async function listUsers(): Promise<AdminUserRow[]> {
  return query<AdminUserRow>(
    `SELECT id, username, role, created_at, discord_username,
            (password_hash <> '!') AS has_password
     FROM admin_users ORDER BY username`,
  );
}

export async function countAdmins(): Promise<number> {
  const rows = await query<{ c: number }>(`SELECT COUNT(*) c FROM admin_users WHERE role='admin'`);
  return Number(rows[0]?.c ?? 0);
}

/** Create a user, or update an existing user's password/role. Role is any RBAC role key. */
export async function upsertUser(username: string, password: string, role: string): Promise<void> {
  await query(
    `INSERT INTO admin_users (username, password_hash, role, created_at) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), role=VALUES(role)`,
    [username, hashPassword(password), role, toMysqlUtc(new Date())],
  );
}

/** Change only a user's role (no password touch), so Discord/self-provisioned accounts can be re-roled. */
export async function setUserRole(username: string, role: string): Promise<void> {
  await query(`UPDATE admin_users SET role=? WHERE username=?`, [role, username]);
}

/** Current stored role for a user, or null if unknown. */
export async function getUserRole(username: string): Promise<string | null> {
  const rows = await query<{ role: string }>(`SELECT role FROM admin_users WHERE username=?`, [username]);
  return rows[0]?.role ?? null;
}

export async function deleteUser(username: string): Promise<void> {
  await query(`DELETE FROM admin_users WHERE username=?`, [username]);
}

// --- Discord SSO linking ---

/** Resolve a linked Discord id to its account (for Discord login). */
export async function findUserByDiscordId(discordId: string): Promise<{ username: string; role: string } | null> {
  const rows = await query<{ username: string; role: string }>(
    `SELECT username, role FROM admin_users WHERE discord_id=?`,
    [discordId],
  );
  return rows[0] ?? null;
}

/** Link a Discord account to an existing user (admin action). Fails if already linked elsewhere. */
export async function linkDiscord(username: string, discordId: string, discordUsername: string): Promise<{ ok: boolean; error?: string }> {
  const taken = await query<{ username: string }>(`SELECT username FROM admin_users WHERE discord_id=? AND username<>?`, [discordId, username]);
  if (taken[0]) return { ok: false, error: `that Discord account is already linked to ${taken[0].username}` };
  await query(`UPDATE admin_users SET discord_id=?, discord_username=? WHERE username=?`, [discordId, discordUsername, username]);
  return { ok: true };
}

/**
 * Create a non-admin account for a Discord login that has no linked account yet, and return
 * it for sign-in. The account has an unusable password (Discord-only) and a unique username
 * derived from the Discord name. Non-admin, so it resolves to the RBAC `member_role`.
 */
export async function provisionDiscordUser(discordId: string, discordUsername: string): Promise<{ username: string; role: string }> {
  // If already linked (race), just return it.
  const existing = await findUserByDiscordId(discordId);
  if (existing) return existing;
  // New self-provisioned Discord logins get the configured member role (least privilege that
  // still owns nodes); an admin can raise or lower it afterwards in /admin/settings.
  let memberRole = "member";
  try { memberRole = (await effectiveConfig()).rbac.member_role || "member"; } catch { /* default */ }
  const base = (discordUsername || `discord_${discordId}`).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 48) || `discord_${discordId}`;
  let username = base;
  for (let i = 0; i < 50; i++) {
    const clash = await query<{ id: number }>(`SELECT id FROM admin_users WHERE username=?`, [username]);
    if (!clash[0]) break;
    username = `${base}_${i + 2}`.slice(0, 60);
  }
  await query(
    `INSERT INTO admin_users (username, password_hash, role, created_at, discord_id, discord_username) VALUES (?, '!', ?, ?, ?, ?)`,
    [username, memberRole, toMysqlUtc(new Date()), discordId, discordUsername || null],
  );
  return { username, role: memberRole };
}

export async function unlinkDiscord(username: string): Promise<void> {
  await query(`UPDATE admin_users SET discord_id=NULL, discord_username=NULL WHERE username=?`, [username]);
}

export async function getUserIdByUsername(username: string): Promise<number | null> {
  const rows = await query<{ id: number }>(`SELECT id FROM admin_users WHERE username=?`, [username]);
  return rows[0] ? Number(rows[0].id) : null;
}

export async function getDiscordLink(username: string): Promise<string | null> {
  const rows = await query<{ discord_username: string | null }>(`SELECT discord_username FROM admin_users WHERE username=?`, [username]);
  return rows[0]?.discord_username ?? null;
}

// --- Per-user preferences (profile page) ---

export interface UserPrefs {
  default_broker?: string;
  default_channel?: string;
}

export async function getUserPrefs(username: string): Promise<UserPrefs> {
  const rows = await query<{ prefs: string | null }>(`SELECT prefs FROM admin_users WHERE username=?`, [username]);
  const raw = rows[0]?.prefs;
  if (!raw) return {};
  try {
    // mysql2 may return JSON columns already parsed (object) or as a string.
    const obj = typeof raw === "string" ? JSON.parse(raw) : (raw as unknown as Record<string, unknown>);
    return {
      default_broker: typeof obj.default_broker === "string" ? obj.default_broker : undefined,
      default_channel: typeof obj.default_channel === "string" ? obj.default_channel : undefined,
    };
  } catch {
    return {};
  }
}

export async function saveUserPrefs(username: string, prefs: UserPrefs): Promise<void> {
  const clean: UserPrefs = {};
  if (prefs.default_broker) clean.default_broker = String(prefs.default_broker).slice(0, 128);
  if (prefs.default_channel) clean.default_channel = String(prefs.default_channel).slice(0, 128);
  await query(`UPDATE admin_users SET prefs=? WHERE username=?`, [JSON.stringify(clean), username]);
}

export async function verifyLogin(username: string, password: string): Promise<string | null> {
  await ensureAdminSeed();
  const rows = await query<{ password_hash: string; role: string }>(
    `SELECT password_hash, role FROM admin_users WHERE username=?`,
    [username],
  );
  const row = rows[0];
  if (!row) return null;
  return verifyPassword(password, row.password_hash) ? row.role : null;
}
