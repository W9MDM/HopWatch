// meshadmin import, callable from the admin UI (and the scripts/import-meshadmin.mjs CLI
// shares the same logic conceptually). Pulls the meshadmin app's data into HopWatch's
// owned-node tables (migration 0020), re-keying ownership onto admin_users. Two source
// modes: a mysqldump .sql string (loaded into a temp db on the HopWatch server), or a live
// MySQL connection. Runs entirely in the web process; target writes go through the pool.
import mysql from "mysql2/promise";
import { query } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";

export interface ImportCounts { users: number; usersCreated: number; groups: number; members: number; nodes: number; perms: number; maint: number; issues: number }
export interface ImportResult { counts: ImportCounts; warnings: string[]; dryRun: boolean }

export type ImportSource =
  | { kind: "sql"; sql: string; meshTable?: string }
  | { kind: "live"; host: string; port?: number; user: string; password: string; adminDb?: string; meshDb?: string; meshTable?: string };

const ISSUE_STATUS: Record<string, string> = { open: "open", in_progress: "in_progress", "in-progress": "in_progress", "in progress": "in_progress", progress: "in_progress", resolved: "resolved", closed: "closed", done: "resolved" };
const normStatus = (s: unknown) => ISSUE_STATUS[String(s ?? "").toLowerCase().trim()] ?? "open";

function numFromNodeId(nodeId: string | null): number | null {
  if (!nodeId) return null;
  const hex = String(nodeId).replace(/^!/, "").trim();
  if (!/^[0-9a-fA-F]{1,8}$/.test(hex)) return null;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n >>> 0 : null;
}
function dt(v: unknown): string {
  const d = v instanceof Date ? v : v ? new Date(v as string) : new Date();
  return toMysqlUtc(Number.isNaN(d.getTime()) ? new Date() : d);
}

// --- mysqldump parser (SQL-file mode) ---
// Parses a standard mysqldump directly in JS so no temporary database (and no CREATE
// privilege) is needed. Reads CREATE TABLE for column order, then INSERT ... VALUES tuples.

interface ParsedTable { columns: string[]; rows: Record<string, unknown>[] }

/** Parse (...),(...) value tuples starting at index `i`, up to the terminating ';'. */
function parseTuples(s: string, i: number): { tuples: (string | number | null)[][]; end: number } {
  const tuples: (string | number | null)[][] = [];
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i]!)) i++;
    if (s[i] === ";") { i++; break; }
    if (s[i] === ",") { i++; continue; }
    if (s[i] !== "(") { i++; continue; }
    i++; // past '('
    const vals: (string | number | null)[] = [];
    while (i < n) {
      while (i < n && /\s/.test(s[i]!)) i++;
      const c = s[i];
      if (c === ")") { i++; break; }
      if (c === ",") { i++; continue; }
      if (c === "'") {
        i++;
        let str = "";
        while (i < n) {
          const ch = s[i];
          if (ch === "\\") { const nx = s[i + 1]!; str += ({ n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", "'": "'", '"': '"' } as Record<string, string>)[nx] ?? nx; i += 2; continue; }
          if (ch === "'") { if (s[i + 1] === "'") { str += "'"; i += 2; continue; } i++; break; }
          str += ch; i++;
        }
        vals.push(str);
      } else {
        let tok = "";
        while (i < n && s[i] !== "," && s[i] !== ")") { tok += s[i]; i++; }
        tok = tok.trim();
        if (tok.toUpperCase() === "NULL" || tok === "") vals.push(null);
        else if (/^-?\d+(\.\d+)?$/.test(tok)) vals.push(Number(tok));
        else vals.push(tok);
      }
    }
    tuples.push(vals);
  }
  return { tuples, end: i };
}

function parseDump(sql: string): Map<string, ParsedTable> {
  const tables = new Map<string, ParsedTable>();
  // Column order from CREATE TABLE (line-based: column lines start with a backtick; key/
  // constraint lines start with a keyword, so they are skipped naturally).
  const lines = sql.split("\n");
  let cur: ParsedTable | null = null;
  for (const raw of lines) {
    const t = raw.trim();
    const cm = t.match(/^CREATE TABLE\s+`?([A-Za-z0-9_]+)`?\s*\(/i);
    if (cm) { cur = { columns: [], rows: [] }; tables.set(cm[1]!, cur); continue; }
    if (cur) {
      if (t.startsWith(")")) { cur = null; continue; }
      const colm = t.match(/^`([A-Za-z0-9_]+)`/);
      if (colm) cur.columns.push(colm[1]!);
    }
  }
  // Rows from INSERT statements (scanned over the whole text; tuples may span lines).
  const insRe = /INSERT\s+INTO\s+`?([A-Za-z0-9_]+)`?\s*(?:\(([^)]*)\))?\s*VALUES\s*/gi;
  let m: RegExpExecArray | null;
  while ((m = insRe.exec(sql))) {
    const name = m[1]!;
    const entry = tables.get(name);
    const cols = m[2] ? m[2].split(",").map((c) => c.trim().replace(/`/g, "")) : entry?.columns;
    if (!entry || !cols || cols.length === 0) continue;
    const { tuples, end } = parseTuples(sql, insRe.lastIndex);
    for (const tup of tuples) {
      const row: Record<string, unknown> = {};
      cols.forEach((c, idx) => { row[c] = tup[idx] ?? null; });
      entry.rows.push(row);
    }
    insRe.lastIndex = end;
  }
  return tables;
}

async function safeAll<T = any>(conn: mysql.Connection, sql: string, warnings: string[]): Promise<T[]> {
  try {
    const [rows] = await conn.query(sql);
    return rows as T[];
  } catch (e) {
    const msg = (e as Error).message;
    if (/doesn't exist|Unknown (column|table)/i.test(msg)) { warnings.push(`skipped: ${msg}`); return []; }
    throw e;
  }
}

/** Import meshadmin data into HopWatch. Returns counts + warnings. */
export async function importMeshadmin(source: ImportSource, dryRun = false): Promise<ImportResult> {
  const warnings: string[] = [];
  const counts: ImportCounts = { users: 0, usersCreated: 0, groups: 0, members: 0, nodes: 0, perms: 0, maint: 0, issues: 0 };
  const meshTable = (source.meshTable && /^[A-Za-z0-9_]+$/.test(source.meshTable) ? source.meshTable : "nodes");

  // readTable(name) yields source rows keyed by column name, from either the parsed dump
  // (SQL-file mode, no server needed) or a live source connection.
  let adminSrc: mysql.Connection | null = null;
  let meshSrc: mysql.Connection | null = null;
  let readTable: (name: string) => Promise<Record<string, any>[]>;

  if (source.kind === "sql") {
    const parsed = parseDump(source.sql);
    readTable = async (name) => {
      const t = parsed.get(name);
      if (!t) { warnings.push(`table \`${name}\` not found in the dump`); return []; }
      return t.rows;
    };
  } else {
    const base = { host: source.host, port: source.port ?? 3306, user: source.user, password: source.password };
    adminSrc = await mysql.createConnection({ ...base, database: source.adminDb || "mesh_network" });
    meshSrc = await mysql.createConnection({ ...base, database: source.meshDb || "meshadmin" });
    readTable = async (name) => safeAll(name === meshTable ? meshSrc! : adminSrc!, `SELECT * FROM \`${name}\``, warnings);
  }

  const userMap = new Map<number, number>();
  const userByLabel = new Map<string, number>();
  const groupMap = new Map<number, number>();
  const nodeMap = new Map<number, number>();
  const label = (s: unknown) => String(s ?? "").trim().toLowerCase();
  let synth = -1; // synthetic ids for dry-run so mapping still works

  // exec: pool write, or a no-op returning a synthetic insertId when dry-running.
  const exec = async (sql: string, params: unknown[]): Promise<{ insertId: number }> => {
    if (dryRun) return { insertId: synth-- };
    const rows = await query<never>(sql, params as (string | number | null)[]);
    return rows as unknown as { insertId: number };
  };
  const tsel = <T = any>(sql: string, params: unknown[]) => query<T>(sql, params as (string | number | null)[]);

  try {
    // 1. USERS -> admin_users
    const users = await readTable("users");
    for (const u of users) {
      counts.users++;
      const discordId = u.discord_id ? String(u.discord_id) : null;
      let hopId: number | null = null;
      if (discordId) { const r = await tsel<{ id: number }>("SELECT id FROM admin_users WHERE discord_id=? LIMIT 1", [discordId]); if (r[0]) hopId = Number(r[0].id); }
      if (!hopId && u.username) {
        const r = await tsel<{ id: number; discord_id: string | null }>("SELECT id, discord_id FROM admin_users WHERE username=? LIMIT 1", [u.username]);
        if (r[0]) { hopId = Number(r[0].id); if (discordId && !r[0].discord_id) await exec("UPDATE admin_users SET discord_id=?, discord_username=? WHERE id=?", [discordId, u.username, hopId]); }
      }
      if (!hopId) {
        let uname = String(u.username || `discord_${discordId || u.id}`).slice(0, 60);
        const clash = await tsel<{ id: number }>("SELECT id FROM admin_users WHERE username=? LIMIT 1", [uname]);
        if (clash[0]) uname = `${uname}_${discordId || u.id}`.slice(0, 64);
        const r = await exec("INSERT INTO admin_users (username, password_hash, role, created_at, discord_id, discord_username) VALUES (?, '!', 'viewer', ?, ?, ?)", [uname, dt(null), discordId, u.username || null]);
        hopId = r.insertId;
        counts.usersCreated++;
      }
      userMap.set(Number(u.id), hopId);
      for (const key of [discordId, u.username, u.username ? `@${u.username}` : null]) { const k = label(key); if (k) userByLabel.set(k, hopId); }
    }

    // 2. GROUPS -> node_group
    const groups = await readTable("groups");
    for (const g of groups) {
      counts.groups++;
      const createdBy = userMap.get(Number(g.created_by)) ?? null;
      const existing = await tsel<{ id: number }>("SELECT id FROM node_group WHERE name=? LIMIT 1", [g.name]);
      let gid: number;
      if (existing[0]) { gid = Number(existing[0].id); await exec("UPDATE node_group SET description=?, created_by=? WHERE id=?", [g.description ?? null, createdBy, gid]); }
      else { const r = await exec("INSERT INTO node_group (name, description, created_by, created_at) VALUES (?,?,?,?)", [g.name, g.description ?? null, createdBy, dt(g.created_at)]); gid = r.insertId; }
      groupMap.set(Number(g.id), gid);
    }

    // 3. GROUP MEMBERS
    const members = await readTable("group_members");
    for (const m of members) {
      const gid = groupMap.get(Number(m.group_id)); const uid = userMap.get(Number(m.user_id));
      if (!gid || !uid) continue;
      await exec("INSERT INTO node_group_member (group_id, user_id, created_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE group_id=group_id", [gid, uid, dt(m.created_at)]);
      counts.members++;
    }

    // 4. NODES -> owned_node
    const nodes = await readTable(meshTable);
    for (const n of nodes) {
      const nodeIdStr = n.node_id != null && n.node_id !== "" ? String(n.node_id) : null;
      const numId = numFromNodeId(nodeIdStr);
      const lat = n.lat ?? n.latitude ?? null;
      const lng = n.lng ?? n.longitude ?? null;
      const ownerType = String(n.owner_type ?? "user").toLowerCase() === "group" ? "group" : "user";
      const ownerStr = n.owner != null ? String(n.owner) : null;
      let ownerUserId: number | null = null, ownerGroupId: number | null = null;
      if (ownerStr) {
        if (ownerType === "group") { const g = await tsel<{ id: number }>("SELECT id FROM node_group WHERE name=? LIMIT 1", [ownerStr]); if (g[0]) ownerGroupId = Number(g[0].id); }
        else {
          ownerUserId = userByLabel.get(label(ownerStr)) ?? null;
          if (!ownerUserId) { const u = await tsel<{ id: number }>("SELECT id FROM admin_users WHERE username=? OR discord_username=? OR discord_id=? LIMIT 1", [ownerStr, ownerStr, ownerStr]); if (u[0]) ownerUserId = Number(u[0].id); }
          if (!ownerUserId) warnings.push(`node "${n.name ?? nodeIdStr}": owner tag "${ownerStr}" has no account yet (will auto-link when that Discord handle signs in)`);
        }
      }
      const vals = [n.name ?? "(unnamed)", nodeIdStr, numId, ownerStr, ownerType, ownerUserId, ownerGroupId, n.model ?? null, n.elevation ?? null, n.frequency ?? "915 MHz", n.mqtt_topic ?? null, n.mqtt_connected ? 1 : 0, n.online ? 1 : 0, n.role ?? "Client", lat, lng, n.planned_site ? 1 : 0, dt(n.created_at)];
      const existing = nodeIdStr
        ? await tsel<{ id: number }>("SELECT id FROM owned_node WHERE node_id=? LIMIT 1", [nodeIdStr])
        : await tsel<{ id: number }>("SELECT id FROM owned_node WHERE node_id IS NULL AND name=? LIMIT 1", [n.name ?? "(unnamed)"]);
      let ownedId: number;
      if (existing[0]) {
        ownedId = Number(existing[0].id);
        await exec("UPDATE owned_node SET name=?, num_id=?, owner=?, owner_type=?, owner_user_id=?, owner_group_id=?, model=?, elevation=?, frequency=?, mqtt_topic=?, mqtt_connected=?, online=?, role=?, lat=?, lng=?, planned_site=? WHERE id=?",
          [vals[0], vals[2], vals[3], vals[4], vals[5], vals[6], vals[7], vals[8], vals[9], vals[10], vals[11], vals[12], vals[13], vals[14], vals[15], vals[16], ownedId]);
      } else {
        const r = await exec("INSERT INTO owned_node (name, node_id, num_id, owner, owner_type, owner_user_id, owner_group_id, model, elevation, frequency, mqtt_topic, mqtt_connected, online, role, lat, lng, planned_site, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", vals);
        ownedId = r.insertId;
      }
      nodeMap.set(Number(n.id), ownedId);
      counts.nodes++;
    }

    // 5. PERMISSIONS -> node_permission
    const perms = await readTable("node_permissions");
    for (const p of perms) {
      const ownedId = nodeMap.get(Number(p.mesh_node_id));
      if (!ownedId) continue;
      const uid = p.user_id != null ? userMap.get(Number(p.user_id)) ?? null : null;
      const gid = p.group_id != null ? groupMap.get(Number(p.group_id)) ?? null : null;
      if (!uid && !gid) continue;
      const level = String(p.permission_level ?? "view").toLowerCase() === "edit" ? "edit" : "view";
      await exec("INSERT INTO node_permission (owned_node_id, user_id, group_id, permission_level, granted_by, granted_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE permission_level=VALUES(permission_level)",
        [ownedId, uid, gid, level, p.granted_by != null ? userMap.get(Number(p.granted_by)) ?? null : null, dt(p.granted_at)]);
      counts.perms++;
    }

    // 6. MAINTENANCE -> node_maintenance
    const maint = await readTable("node_maintenance");
    for (const m of maint) {
      const ownedId = nodeMap.get(Number(m.mesh_node_id));
      if (!ownedId) continue;
      await exec("INSERT INTO node_maintenance (owned_node_id, user_id, visit_date, notes, created_at) VALUES (?,?,?,?,?)", [ownedId, userMap.get(Number(m.user_id)) ?? null, dt(m.visit_date), m.notes ?? null, dt(m.created_at)]);
      counts.maint++;
    }

    // 7. ISSUES -> node_issue
    const issues = await readTable("node_issues");
    for (const it of issues) {
      const ownedId = nodeMap.get(Number(it.mesh_node_id));
      if (!ownedId) continue;
      await exec("INSERT INTO node_issue (owned_node_id, reported_by, issue_type, description, status, reported_at, resolved_at) VALUES (?,?,?,?,?,?,?)",
        [ownedId, userMap.get(Number(it.reported_by)) ?? null, it.issue_type ?? "issue", it.description ?? null, normStatus(it.status), dt(it.reported_at), it.resolved_at ? dt(it.resolved_at) : null]);
      counts.issues++;
    }
  } finally {
    if (adminSrc) await adminSrc.end().catch(() => {});
    if (meshSrc && meshSrc !== adminSrc) await meshSrc.end().catch(() => {});
  }

  return { counts, warnings, dryRun };
}
