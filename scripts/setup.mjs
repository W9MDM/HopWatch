#!/usr/bin/env node
// HopWatch installer. Cross-platform (Node only). Steps:
//   1. check Node version
//   2. create config/hopwatch.yaml and .env from examples if missing
//   3. create data directories
//   4. npm install
//   5. (optional --create-db) create the MySQL database + user via admin creds
//   6. run migrations
//   7. print next steps
//
// Flags:
//   --create-db      create the database and user (needs admin creds, see below)
//   --skip-install   do not run npm install
//   --skip-migrate   do not run migrations
//
// Admin creds for --create-db come from the environment:
//   HOPWATCH_DB_ADMIN_USER (default "root"), HOPWATCH_DB_ADMIN_PASSWORD
//   (falls back to MYSQL_ROOT_PASSWORD). Target db/user/password are read from
//   config/hopwatch.yaml (with ${ENV} placeholders resolved from .env).

import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const args = new Set(process.argv.slice(2));
const createDb = args.has("--create-db");
const skipInstall = args.has("--skip-install");
const skipMigrate = args.has("--skip-migrate");

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const step = (s) => console.log("\n" + bold(">>> " + s));
const ok = (s) => console.log("  " + s);
const warn = (s) => console.warn("  ! " + s);

// 1. Node version
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 6)) {
  console.error(`HopWatch needs Node >= 22.6 (found ${process.versions.node}).`);
  process.exit(1);
}

// 2. config + env
step("Preparing config");
copyIfMissing("config/hopwatch.example.yaml", "config/hopwatch.yaml", "timezone + tiles; brokers and channel keys are configured in the admin UI");
copyIfMissing(".env.example", ".env", "point HOPWATCH_DB_* at your database; the session/master/admin secrets are generated below");
hardenEnv(".env"); // never ship the public placeholder secrets: generate strong ones + lock the file

// Replace the example placeholder secrets in .env with strong random values (a known session
// secret would let anyone forge an admin session once the repo is public), and restrict the file
// to the owner. Only the bootstrap secrets live in env; everything else is entered in the admin UI
// and encrypted at rest in the DB with the master key.
function hardenEnv(path) {
  if (!existsSync(path)) return;
  let txt = readFileSync(path, "utf8");
  const gen = (n) => randomBytes(n).toString("hex");
  const swap = (key, placeholder, val) => {
    const re = new RegExp(`^(${key}=)(.*)$`, "m");
    const m = txt.match(re);
    if (m && (m[2].trim() === "" || m[2].trim() === placeholder)) { txt = txt.replace(re, `$1${val}`); return true; }
    return false;
  };
  const gened = [];
  if (swap("HOPWATCH_SESSION_SECRET", "change-me-to-a-long-random-string", gen(32))) gened.push("HOPWATCH_SESSION_SECRET");
  if (swap("HOPWATCH_MASTER_KEY", "change-me-to-a-different-long-random-string", gen(32))) gened.push("HOPWATCH_MASTER_KEY");
  const adminPw = gen(9);
  const adminSet = swap("HOPWATCH_ADMIN_PASSWORD", "changeme", adminPw);
  if (gened.length || adminSet) writeFileSync(path, txt);
  if (gened.length) ok(`generated strong ${gened.join(" + ")} in .env`);
  if (adminSet) ok(`generated admin password (save it, then change it in the UI): ${adminPw}`);
  try { chmodSync(path, 0o600); ok(".env restricted to owner (chmod 600)"); } catch { /* not POSIX (Windows dev) */ }
}

// 3. data dirs
for (const d of ["data", "data/spool", "data/terrain"]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
ok("data directories ready");

// Load .env so ${...} placeholders and admin creds resolve.
try {
  process.loadEnvFile(".env");
} catch {
  /* .env optional */
}

// 4. npm install
if (!skipInstall) {
  step("Installing dependencies (npm install)");
  const r = spawnSync("npm", ["install", "--no-fund", "--no-audit"], { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error("npm install failed.");
    process.exit(1);
  }
} else {
  ok("skipping npm install (--skip-install)");
}

// 5. optional DB creation
if (createDb) {
  step("Creating MySQL database and user");
  try {
    const cfg = await readDbConfig();
    const adminUser = process.env.HOPWATCH_DB_ADMIN_USER || "root";
    const adminPass = process.env.HOPWATCH_DB_ADMIN_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || "";
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: adminUser, password: adminPass });
    const dbId = conn.escapeId(cfg.database);
    const user = conn.escape(cfg.user);
    const pass = conn.escape(cfg.password);
    await conn.query(`CREATE DATABASE IF NOT EXISTS ${dbId} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await conn.query(`CREATE USER IF NOT EXISTS ${user}@'%' IDENTIFIED BY ${pass}`);
    await conn.query(`GRANT ALL PRIVILEGES ON ${dbId}.* TO ${user}@'%'`);
    await conn.query("FLUSH PRIVILEGES");
    await conn.end();
    ok(`database '${cfg.database}' and user '${cfg.user}' ready`);
  } catch (e) {
    warn(`could not create database: ${e.message}`);
    warn("create it manually (see README) and re-run with --skip-install.");
  }
}

// 6. migrate
if (!skipMigrate) {
  step("Running migrations");
  const m = spawnSync("npm", ["run", "migrate"], { stdio: "inherit", shell: true });
  if (m.status !== 0) warn("migrations failed. Ensure MySQL is running and config/.env are correct, then: npm run migrate");
} else {
  ok("skipping migrations (--skip-migrate)");
}

// 7. next steps
step("Setup complete");
console.log(`
Start the three processes (each in its own terminal):
    npm run ingest      MQTT -> MySQL
    npm run worker      rollups, alerts, retention
    npm run dev         web UI + API at http://localhost:3000

For production: npm run build && npm run start (plus ingest and worker).
Admin sign-in is at /admin/login once HOPWATCH_SESSION_SECRET and HOPWATCH_ADMIN_PASSWORD are set.
`);

function copyIfMissing(from, to, hint) {
  if (existsSync(to)) {
    ok(`${to} exists`);
  } else if (existsSync(from)) {
    copyFileSync(from, to);
    ok(`created ${to} (${hint})`);
  } else {
    warn(`missing ${from}; cannot create ${to}`);
  }
}

async function readDbConfig() {
  const { parse } = await import("yaml");
  const y = parse(readFileSync("config/hopwatch.yaml", "utf8"));
  const m = (y && y.database && y.database.mysql) || {};
  const resolve = (v) =>
    typeof v === "string" ? v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? "") : v;
  return {
    host: resolve(m.host) || "127.0.0.1",
    port: Number(m.port) || 3306,
    database: resolve(m.database) || "hopwatch",
    user: resolve(m.user) || "hopwatch",
    password: resolve(m.password) || "",
  };
}
