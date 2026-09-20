#!/usr/bin/env node
// One-shot importer: pull the standalone meshadmin app's data into HopWatch.
//
// meshadmin keeps two MySQL databases: an "admin" DB (users, roles, groups,
// group_members, node_permissions, node_maintenance, node_issues) and a "mesh" DB with
// the curated node registry (default table `nodes`). This script copies all of it into
// HopWatch's owned-node tables (migration 0020), re-keying ownership onto HopWatch's own
// admin_users so there is a single identity system. Discord users that have no HopWatch
// account are created as linked viewer accounts.
//
// The HopWatch target connection is read from config/hopwatch.yaml + .env (same as the
// installer). Source connection details are passed as flags so no new persistent env vars
// are introduced:
//
//   node scripts/import-meshadmin.mjs \
//     --src-host localhost --src-user root --src-password secret \
//     [--src-admin-db mesh_network] [--src-mesh-db meshadmin] [--src-mesh-table nodes] \
//     [--src-port 3306] [--dry-run]
//
// Or import straight from a mysqldump .sql file (no live source server, no extra MySQL
// privileges: the dump is parsed in-process):
//
//   node scripts/import-meshadmin.mjs --src-sql-file ./meshadmin.sql [--src-mesh-table nodes] [--dry-run]
//
// If the dump holds only the nodes table, owners are matched against existing HopWatch
// accounts by name; the users/groups/permissions/maintenance/issues tables are imported too
// when present in the dump.
//
// Re-runnable: owned nodes are matched by node_id (or name when node_id is absent), users
// by discord_id, groups by name, so a second run updates rather than duplicating.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
try { process.loadEnvFile(".env"); } catch { /* .env optional */ }

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const DRY = has("dry-run");
const src = {
  host: flag("src-host", "localhost"),
  port: Number(flag("src-port", "3306")),
  user: flag("src-user", "root"),
  password: flag("src-password", ""),
  adminDb: flag("src-admin-db", "mesh_network"),
  meshDb: flag("src-mesh-db", "meshadmin"),
  meshTable: flag("src-mesh-table", "nodes"),
  sqlFile: flag("src-sql-file", ""),          // mysqldump .sql to import from (no live source needed)
  tmpDb: flag("src-tmp-db", "hopwatch_import_src"),
};
const explicitAdminDb = has("src-admin-db");
const explicitMeshDb = has("src-mesh-db");

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const step = (s) => console.log("\n" + bold(">>> " + s));
const ok = (s) => console.log("  " + s);
const warn = (s) => console.warn("  ! " + s);

// DATETIME(3) UTC string, matching HopWatch's storage convention.
function dt(v) {
  const d = v instanceof Date ? v : v ? new Date(v) : new Date();
  if (Number.isNaN(d.getTime())) return dt(new Date());
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

// "!a1b2c3d4" or "a1b2c3d4" -> numeric node id, else null.
function numFromNodeId(nodeId) {
  if (!nodeId) return null;
  const hex = String(nodeId).replace(/^!/, "").trim();
  if (!/^[0-9a-fA-F]{1,8}$/.test(hex)) return null;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n >>> 0 : null;
}

const ISSUE_STATUS = { open: "open", "in_progress": "in_progress", "in-progress": "in_progress", "in progress": "in_progress", progress: "in_progress", resolved: "resolved", closed: "closed", done: "resolved" };
function normStatus(s) {
  return ISSUE_STATUS[String(s ?? "").toLowerCase().trim()] ?? "open";
}

async function readTargetDbConfig() {
  const { parse } = await import("yaml");
  const y = parse(readFileSync("config/hopwatch.yaml", "utf8"));
  const m = (y && y.database && y.database.mysql) || {};
  const resolve = (v) => (typeof v === "string" ? v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? "") : v);
  return {
    host: resolve(m.host) || "127.0.0.1",
    port: Number(m.port) || 3306,
    database: resolve(m.database) || "hopwatch",
    user: resolve(m.user) || "hopwatch",
    password: resolve(m.password) || "",
  };
}

// Defensive SELECT: only tables/columns that exist. Returns [] if the table is missing.
async function safeAll(conn, sql, params = []) {
  try {
    const [rows] = await conn.query(sql, params);
    return rows;
  } catch (e) {
    if (/doesn't exist|Unknown (column|table)/i.test(e.message)) {
      warn(`skipped (${e.message})`);
      return [];
    }
    throw e;
  }
}

// --- mysqldump parser (SQL-file mode): parse the dump in-process, no temp database needed.
function parseTuples(s, i) {
  const tuples = []; const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (s[i] === ";") { i++; break; }
    if (s[i] === ",") { i++; continue; }
    if (s[i] !== "(") { i++; continue; }
    i++;
    const vals = [];
    while (i < n) {
      while (i < n && /\s/.test(s[i])) i++;
      const c = s[i];
      if (c === ")") { i++; break; }
      if (c === ",") { i++; continue; }
      if (c === "'") {
        i++; let str = "";
        while (i < n) {
          const ch = s[i];
          if (ch === "\\") { const nx = s[i + 1]; str += ({ n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", "'": "'", '"': '"' })[nx] ?? nx; i += 2; continue; }
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

function parseDump(sql) {
  const tables = new Map();
  let cur = null;
  for (const raw of sql.split("\n")) {
    const t = raw.trim();
    const cm = t.match(/^CREATE TABLE\s+`?([A-Za-z0-9_]+)`?\s*\(/i);
    if (cm) { cur = { columns: [], rows: [] }; tables.set(cm[1], cur); continue; }
    if (cur) {
      if (t.startsWith(")")) { cur = null; continue; }
      const colm = t.match(/^`([A-Za-z0-9_]+)`/);
      if (colm) cur.columns.push(colm[1]);
    }
  }
  const insRe = /INSERT\s+INTO\s+`?([A-Za-z0-9_]+)`?\s*(?:\(([^)]*)\))?\s*VALUES\s*/gi;
  let m;
  while ((m = insRe.exec(sql))) {
    const entry = tables.get(m[1]);
    const cols = m[2] ? m[2].split(",").map((c) => c.trim().replace(/`/g, "")) : entry?.columns;
    if (!entry || !cols || cols.length === 0) continue;
    const { tuples, end } = parseTuples(sql, insRe.lastIndex);
    for (const tup of tuples) { const row = {}; cols.forEach((c, idx) => { row[c] = tup[idx] ?? null; }); entry.rows.push(row); }
    insRe.lastIndex = end;
  }
  return tables;
}

async function main() {
  const mysql = await import("mysql2/promise");
  const tgtCfg = await readTargetDbConfig();

  // readTable(name) yields source rows: parsed from the .sql dump (no server / privileges
  // needed), or read from a live source connection.
  let adminSrc = null, meshSrc = null, readTable;
  if (src.sqlFile) {
    step("Parsing SQL dump");
    const parsed = parseDump(readFileSync(src.sqlFile, "utf8"));
    ok(`parsed ${parsed.size} table(s) from ${src.sqlFile}`);
    readTable = async (name) => { const t = parsed.get(name); if (!t) { warn(`table ${name} not in dump`); return []; } return t.rows; };
    step(`Importing (dry-run: ${DRY ? "yes" : "no"})`);
    ok(`target: ${tgtCfg.user}@${tgtCfg.host}:${tgtCfg.port}/${tgtCfg.database}`);
  } else {
    step(`Connecting (dry-run: ${DRY ? "yes" : "no"})`);
    ok(`source admin db: ${src.user}@${src.host}:${src.port}/${src.adminDb}`);
    ok(`source mesh db:  ${src.meshDb}.${src.meshTable}`);
    ok(`target:          ${tgtCfg.user}@${tgtCfg.host}:${tgtCfg.port}/${tgtCfg.database}`);
    adminSrc = await mysql.createConnection({ host: src.host, port: src.port, user: src.user, password: src.password, database: src.adminDb });
    meshSrc = await mysql.createConnection({ host: src.host, port: src.port, user: src.user, password: src.password, database: src.meshDb });
    readTable = async (name) => safeAll(name === src.meshTable ? meshSrc : adminSrc, `SELECT * FROM \`${name}\``);
  }
  const tgt = await mysql.createConnection({ host: tgtCfg.host, port: tgtCfg.port, user: tgtCfg.user, password: tgtCfg.password, database: tgtCfg.database, multipleStatements: false });

  const counts = { users: 0, usersCreated: 0, groups: 0, members: 0, nodes: 0, perms: 0, maint: 0, issues: 0 };
  const userMap = new Map();      // src users.id -> hopwatch admin_users.id
  const userByLabel = new Map();  // lowercased owner label (username / discord_id) -> hopwatch admin_users.id
  const groupMap = new Map();     // src groups.id -> node_group.id
  const nodeMap = new Map();      // src nodes.id -> owned_node.id
  const label = (s) => String(s ?? "").trim().toLowerCase();

  const exec = async (sql, params) => {
    if (DRY) return { insertId: 0, affectedRows: 0 };
    const [r] = await tgt.query(sql, params);
    return r;
  };

  try {
    // 1. USERS -> admin_users (match by discord_id; create linked viewer if missing).
    step("Importing users");
    const users = await readTable("users");
    for (const u of users) {
      counts.users++;
      const discordId = u.discord_id ? String(u.discord_id) : null;
      let hopId = null;
      if (discordId) {
        const [byDiscord] = await tgt.query("SELECT id FROM admin_users WHERE discord_id = ? LIMIT 1", [discordId]);
        if (byDiscord.length) hopId = byDiscord[0].id;
      }
      if (!hopId && u.username) {
        const [byName] = await tgt.query("SELECT id, discord_id FROM admin_users WHERE username = ? LIMIT 1", [u.username]);
        if (byName.length) {
          hopId = byName[0].id;
          if (discordId && !byName[0].discord_id) await exec("UPDATE admin_users SET discord_id = ?, discord_username = ? WHERE id = ?", [discordId, u.username, hopId]);
        }
      }
      if (!hopId) {
        // Create a linked viewer account. Ensure a unique username.
        let uname = (u.username || `discord_${discordId || u.id}`).slice(0, 60);
        const [clash] = await tgt.query("SELECT id FROM admin_users WHERE username = ? LIMIT 1", [uname]);
        if (clash.length) uname = `${uname}_${discordId || u.id}`.slice(0, 64);
        const r = await exec(
          "INSERT INTO admin_users (username, password_hash, role, created_at, discord_id, discord_username) VALUES (?, '!', 'viewer', ?, ?, ?)",
          [uname, dt(), discordId, u.username || null]
        );
        hopId = DRY ? -Number(u.id) : r.insertId;
        counts.usersCreated++;
      }
      userMap.set(Number(u.id), hopId);
      // Index every label a node's free-text `owner` might carry so ownership resolves to
      // the correct Discord-linked account: the discord id, the discord username, and the
      // "username#disc_id" / "@username" variants meshadmin sometimes stored.
      for (const key of [discordId, u.username, u.username ? `@${u.username}` : null]) {
        const k = label(key);
        if (k) userByLabel.set(k, hopId);
      }
    }
    ok(`${counts.users} users (${counts.usersCreated} new accounts created)`);

    // 2. GROUPS -> node_group (match by name).
    step("Importing groups");
    const groups = await readTable("groups");
    for (const g of groups) {
      counts.groups++;
      const createdBy = userMap.get(Number(g.created_by)) ?? null;
      const [existing] = await tgt.query("SELECT id FROM node_group WHERE name = ? LIMIT 1", [g.name]);
      let gid;
      if (existing.length) {
        gid = existing[0].id;
        await exec("UPDATE node_group SET description = ?, created_by = ? WHERE id = ?", [g.description ?? null, createdBy, gid]);
      } else {
        const r = await exec("INSERT INTO node_group (name, description, created_by, created_at) VALUES (?, ?, ?, ?)", [g.name, g.description ?? null, createdBy, dt(g.created_at)]);
        gid = DRY ? -Number(g.id) : r.insertId;
      }
      groupMap.set(Number(g.id), gid);
    }
    ok(`${counts.groups} groups`);

    // 3. GROUP MEMBERS -> node_group_member.
    step("Importing group members");
    const members = await readTable("group_members");
    for (const m of members) {
      const gid = groupMap.get(Number(m.group_id));
      const uid = userMap.get(Number(m.user_id));
      if (!gid || !uid) continue;
      await exec("INSERT INTO node_group_member (group_id, user_id, created_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE group_id = group_id", [gid, uid, dt(m.created_at)]);
      counts.members++;
    }
    ok(`${counts.members} memberships`);

    // 4. NODES -> owned_node (match by node_id string, else by name).
    step("Importing owned nodes");
    const nodes = await readTable(src.meshTable);
    for (const n of nodes) {
      const nodeIdStr = n.node_id != null && n.node_id !== "" ? String(n.node_id) : null;
      const numId = numFromNodeId(nodeIdStr);
      const lat = n.lat ?? n.latitude ?? null;
      const lng = n.lng ?? n.longitude ?? null;
      const ownerType = String(n.owner_type ?? "user").toLowerCase() === "group" ? "group" : "user";
      const ownerStr = n.owner != null ? String(n.owner) : null;

      // Resolve integrated owner from the free-text owner label. For user-owned nodes,
      // prefer the source users index (label -> the Discord-linked HopWatch account) so a
      // node ties to the right Discord user even if its owner label is a discord id, a
      // username, or an "@name" variant. Fall back to a direct admin_users match.
      let ownerUserId = null, ownerGroupId = null;
      if (ownerStr) {
        if (ownerType === "group") {
          const [g] = await tgt.query("SELECT id FROM node_group WHERE name = ? LIMIT 1", [ownerStr]);
          if (g.length) ownerGroupId = g[0].id;
        } else {
          ownerUserId = userByLabel.get(label(ownerStr)) ?? null;
          if (!ownerUserId) {
            const [u] = await tgt.query("SELECT id FROM admin_users WHERE username = ? OR discord_username = ? OR discord_id = ? LIMIT 1", [ownerStr, ownerStr, ownerStr]);
            if (u.length) ownerUserId = u[0].id;
          }
          if (!ownerUserId) warn(`node "${n.name ?? nodeIdStr}": owner tag "${ownerStr}" has no account yet (will auto-link when that Discord handle signs in)`);
        }
      }

      const vals = [
        n.name ?? "(unnamed)", nodeIdStr, numId, ownerStr, ownerType, ownerUserId, ownerGroupId,
        n.model ?? null, n.elevation ?? null, n.frequency ?? "915 MHz", n.mqtt_topic ?? null,
        n.mqtt_connected ? 1 : 0, n.online ? 1 : 0, n.role ?? "Client", lat, lng, n.planned_site ? 1 : 0, dt(n.created_at),
      ];

      let ownedId;
      const [existing] = nodeIdStr
        ? await tgt.query("SELECT id FROM owned_node WHERE node_id = ? LIMIT 1", [nodeIdStr])
        : await tgt.query("SELECT id FROM owned_node WHERE node_id IS NULL AND name = ? LIMIT 1", [n.name ?? "(unnamed)"]);
      if (existing.length) {
        ownedId = existing[0].id;
        await exec(
          `UPDATE owned_node SET name=?, num_id=?, owner=?, owner_type=?, owner_user_id=?, owner_group_id=?, model=?, elevation=?, frequency=?, mqtt_topic=?, mqtt_connected=?, online=?, role=?, lat=?, lng=?, planned_site=? WHERE id=?`,
          [vals[0], vals[2], vals[3], vals[4], vals[5], vals[6], vals[7], vals[8], vals[9], vals[10], vals[11], vals[12], vals[13], vals[14], vals[15], vals[16], ownedId]
        );
      } else {
        const r = await exec(
          `INSERT INTO owned_node (name, node_id, num_id, owner, owner_type, owner_user_id, owner_group_id, model, elevation, frequency, mqtt_topic, mqtt_connected, online, role, lat, lng, planned_site, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          vals
        );
        ownedId = DRY ? -Number(n.id) : r.insertId;
      }
      nodeMap.set(Number(n.id), ownedId);
      counts.nodes++;
    }
    ok(`${counts.nodes} owned nodes`);

    // 5. NODE PERMISSIONS -> node_permission.
    step("Importing node shares");
    const perms = await readTable("node_permissions");
    for (const p of perms) {
      const ownedId = nodeMap.get(Number(p.mesh_node_id));
      if (!ownedId) continue;
      const uid = p.user_id != null ? userMap.get(Number(p.user_id)) ?? null : null;
      const gid = p.group_id != null ? groupMap.get(Number(p.group_id)) ?? null : null;
      if (!uid && !gid) continue;
      const level = String(p.permission_level ?? "view").toLowerCase() === "edit" ? "edit" : "view";
      const grantedBy = p.granted_by != null ? userMap.get(Number(p.granted_by)) ?? null : null;
      await exec(
        "INSERT INTO node_permission (owned_node_id, user_id, group_id, permission_level, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE permission_level = VALUES(permission_level)",
        [ownedId, uid, gid, level, grantedBy, dt(p.granted_at)]
      );
      counts.perms++;
    }
    ok(`${counts.perms} shares`);

    // 6. MAINTENANCE -> node_maintenance.
    step("Importing maintenance logs");
    const maint = await readTable("node_maintenance");
    for (const m of maint) {
      const ownedId = nodeMap.get(Number(m.mesh_node_id));
      if (!ownedId) continue;
      await exec("INSERT INTO node_maintenance (owned_node_id, user_id, visit_date, notes, created_at) VALUES (?, ?, ?, ?, ?)", [ownedId, userMap.get(Number(m.user_id)) ?? null, dt(m.visit_date), m.notes ?? null, dt(m.created_at)]);
      counts.maint++;
    }
    ok(`${counts.maint} maintenance entries`);

    // 7. ISSUES -> node_issue.
    step("Importing issues");
    const issues = await readTable("node_issues");
    for (const it of issues) {
      const ownedId = nodeMap.get(Number(it.mesh_node_id));
      if (!ownedId) continue;
      await exec(
        "INSERT INTO node_issue (owned_node_id, reported_by, issue_type, description, status, reported_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [ownedId, userMap.get(Number(it.reported_by)) ?? null, it.issue_type ?? "issue", it.description ?? null, normStatus(it.status), dt(it.reported_at), it.resolved_at ? dt(it.resolved_at) : null]
      );
      counts.issues++;
    }
    ok(`${counts.issues} issues`);

    step(DRY ? "Dry run complete (no rows written)" : "Import complete");
    console.log("  " + JSON.stringify(counts));
  } finally {
    if (adminSrc) await adminSrc.end().catch(() => {});
    if (meshSrc) await meshSrc.end().catch(() => {});
    await tgt.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error("\nImport failed: " + e.message);
  process.exit(1);
});
