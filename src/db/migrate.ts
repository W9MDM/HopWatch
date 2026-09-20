// Migration runner. Applied on startup by ingest/worker/web (idempotent) and via
// `npm run migrate`. Reads db/migrations/*.sql in filename order and applies any
// not yet recorded in schema_migrations. Statements are split on ';' (the schema
// contains no stored routines, so this is safe).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool, closePool } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");
/** Marks a schema_migrations row as "this file is partially applied", so it is not mistaken for a
 * completed migration while still recording how far the failed run got. */
const PARTIAL_SUFFIX = " (partial)";

export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(255) NOT NULL,
      applied_at DATETIME(3)  NOT NULL,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // statements_done records how far a file got. Added here rather than as a migration because the
  // runner needs it before it can apply anything.
  await pool.query("ALTER TABLE schema_migrations ADD COLUMN statements_done INT NOT NULL DEFAULT 0").catch(() => {});

  const [appliedRows] = await pool.query("SELECT name, statements_done FROM schema_migrations");
  const rows = appliedRows as { name: string; statements_done: number }[];
  const applied = new Set(rows.filter((r) => !r.name.endsWith(PARTIAL_SUFFIX)).map((r) => r.name));
  // file -> statements already applied by a previous, failed run.
  const partial = new Map<string, number>(
    rows
      .filter((r) => r.name.endsWith(PARTIAL_SUFFIX))
      .map((r) => [r.name.slice(0, -PARTIAL_SUFFIX.length), Number(r.statements_done) || 0]),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const statements = splitStatements(sql);
    const conn = await pool.getConnection();
    // NO transaction. In MySQL and MariaDB, DDL causes an implicit commit and cannot be rolled
    // back, so wrapping a migration in one was worse than useless: the rollback discarded only the
    // schema_migrations INSERT, never the DDL that had already run. The file was therefore not
    // recorded, the next start re-ran it from statement 1, that statement failed as
    // already-applied, and runMigrations rethrows into an unguarded `await runMigrations()` at the
    // top of main() in BOTH the worker and the ingest daemon: a permanent systemd restart loop from
    // one partially-applied file. Several shipped migrations are multi-statement, so the window is
    // real.
    //
    // Instead: record progress per statement. On failure the file is recorded as PARTIAL with the
    // index reached, and the next run resumes from there rather than replaying what already
    // succeeded, so a fixable failure (a lock timeout, a missing grant) is recoverable by restarting
    // rather than by hand-editing schema_migrations.
    const startAt = partial.get(file) ?? 0;
    if (startAt > 0) console.log(`[migrate] resuming ${file} at statement ${startAt + 1}/${statements.length}`);
    let i = startAt;
    try {
      for (; i < statements.length; i++) await conn.query(statements[i]!);
      await conn.query(
        `INSERT INTO schema_migrations (name, applied_at, statements_done) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE applied_at=VALUES(applied_at), statements_done=VALUES(statements_done)`,
        [file, toMysqlUtc(new Date()), statements.length],
      );
      if (startAt > 0) await conn.query("DELETE FROM schema_migrations WHERE name=?", [file + PARTIAL_SUFFIX]).catch(() => {});
      newlyApplied.push(file);
      console.log(`[migrate] applied ${file} (${statements.length} statements)`);
    } catch (e) {
      // Remember how far we got, so the retry does not replay applied DDL.
      await conn
        .query(
          `INSERT INTO schema_migrations (name, applied_at, statements_done) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE statements_done=VALUES(statements_done)`,
          [file + PARTIAL_SUFFIX, toMysqlUtc(new Date()), i],
        )
        .catch(() => {});
      throw new Error(
        `Migration ${file} failed at statement ${i + 1}/${statements.length}: ${(e as Error).message}. ` +
          `Statements 1..${i} were applied and will be skipped on the next run.`,
      );
    } finally {
      conn.release();
    }
  }
  if (newlyApplied.length === 0) console.log("[migrate] up to date");
  return newlyApplied;
}

function splitStatements(sql: string): string[] {
  // Strip whole-line comments FIRST, then split on ';'. Doing it in this order
  // matters: comment lines may themselves contain ';' (e.g. "unique key; no FKs"),
  // which would otherwise leak comment text into the following statement. Inline
  // comments after code on a line are left in place; MariaDB/MySQL parse "-- ".
  const withoutComments = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, "")) // strip full-line AND inline "-- ..." comments
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Allow running directly: `tsx src/db/migrate.ts`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrate.ts")) {
  runMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[migrate] " + e.message);
      process.exit(1);
    });
}
