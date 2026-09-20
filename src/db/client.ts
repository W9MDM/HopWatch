import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config/load.ts";

// Shared MySQL pool. The Next app, ingest, and worker each create their own pool
// in their own process; MySQL is the only channel between them (spec §2).

let pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (pool) return pool;
  const cfg = loadConfig();
  if (cfg.database.mode !== "mysql") {
    throw new Error(`database.mode='${cfg.database.mode}' is not supported yet (Phase 1 targets MySQL)`);
  }
  const m = cfg.database.mysql;
  const useSocket = m.socket_path.length > 0;
  pool = mysql.createPool({
    ...(useSocket ? { socketPath: m.socket_path } : { host: m.host, port: m.port }),
    database: m.database,
    user: m.user,
    password: m.password,
    connectionLimit: m.pool.max,
    waitForConnections: true,
    // DATETIME columns are UTC; disable driver tz translation and treat as strings.
    timezone: "Z",
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    ssl: m.tls.enabled
      ? {
          ca: m.tls.ca_file ? readFileSync(m.tls.ca_file) : undefined,
          rejectUnauthorized: m.tls.reject_unauthorized,
        }
      : undefined,
  });
  return pool;
}

/** Convenience query helper returning typed rows. */
export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await getPool().execute(sql, params as (string | number | null)[]);
  return rows as T[];
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Clamp a row limit for interpolation after `LIMIT`, tolerating garbage.
 *
 * `Math.min(Math.max(x, 1), n)` is NaN-transparent (`Math.max(NaN, 1)` is NaN), so a request like
 * `?limit=abc` reached the SQL text as the literal `LIMIT NaN`. mysql2 then threw a parse error at
 * prepare time and the route's catch returned HTTP 503 with the MySQL message, which is both the
 * wrong status for bad client input and an echo of the server's SQL to the caller. Every paging
 * clamp in this layer goes through here instead.
 */
export function clampLimit(value: unknown, max: number, fallback = max): number {
  const dflt = Math.min(Math.max(Math.floor(fallback), 1), max);
  // An absent or blank parameter means "use the default", not "one row": `?limit=` and a missing
  // `?limit` should behave the same, and Number("") is 0, which would otherwise clamp to 1.
  if (value === null || value === undefined || value === "") return dflt;
  if (typeof value !== "number" && typeof value !== "string") return dflt;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, 1), max);
}
