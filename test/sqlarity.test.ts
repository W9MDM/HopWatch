import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Static guard for a bug class the type checker cannot see: an INSERT whose declared column
// list and its VALUES row disagree. Every write in this repo is hand-written SQL
// executed through mysql2, so a mismatch is not a compile error, it is a runtime
// "Column count doesn't match value count" the moment that code path is first exercised, which
// for an ingest or worker write may be long after deploy.
//
// This scans the real source instead of duplicating a column list a test would have to be kept
// in sync with, so it keeps working as inserts are edited.

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === ".next") continue;
      walk(p, out);
    } else if (p.endsWith(".ts") || p.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

/** Split on commas at paren depth 0, so `DECIMAL(6,2)` and `COALESCE(a,b)` count as one item. */
function topLevelSplit(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Match the balanced parenthesized group starting at `open`. */
function matchGroup(s: string, open: number): { body: string; end: number } | null {
  if (s[open] !== "(") return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return { body: s.slice(open + 1, i), end: i };
    }
  }
  return null;
}

interface Insert { file: string; table: string; cols: number; values: number; colNames: string[]; valueList: string }

/**
 * Find `INSERT ... INTO <table> ( <cols> ) VALUES ( <values> )` occurrences.
 *
 * Counts VALUE EXPRESSIONS, not '?' characters: this codebase legitimately mixes literals into
 * the row (e.g. `VALUES (?,?,?,?,1,?,?,?)` and `VALUES (?,?,?,'position',?)`), so counting
 * placeholders alone reports a false mismatch on perfectly correct SQL.
 *
 * Skips INSERT..SELECT forms (the rollup folds), whose arity is a SELECT list rather than a row.
 */
function findInserts(file: string, src: string): Insert[] {
  const out: Insert[] = [];
  const re = /INSERT\s+(?:IGNORE\s+)?INTO\s+([a-z_][a-z0-9_]*)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const colGroup = matchGroup(src, openParen);
    if (!colGroup) continue;
    // What follows the column list must be VALUES( ... ) for this check to apply.
    const after = src.slice(colGroup.end + 1, colGroup.end + 40);
    const vm = after.match(/^\s*VALUES\s*\(/i);
    if (!vm) continue; // INSERT..SELECT, or a shape this guard does not model
    const valOpen = colGroup.end + 1 + vm[0].length - 1;
    const valGroup = matchGroup(src, valOpen);
    if (!valGroup) continue;
    if (!valGroup.body.includes("?")) continue; // literal-only row: nothing bound, not our concern
    const values = topLevelSplit(valGroup.body).length;
    const colNames = topLevelSplit(colGroup.body);
    out.push({ file, table: m[1]!, cols: colNames.length, values, colNames, valueList: valGroup.body.replace(/\s+/g, " ").trim() });
  }
  return out;
}

test("every parameterized INSERT has matching column and value counts", () => {
  const files = walk("src");
  const inserts = files.flatMap((f) => findInserts(f, readFileSync(f, "utf8")));

  // Sanity: if the scanner stops finding inserts, the guard has silently stopped guarding.
  assert.ok(inserts.length >= 15, `expected to find many INSERTs, found ${inserts.length}`);

  const bad = inserts.filter((i) => i.cols !== i.values);
  const detail = bad
    .map((b) => `${b.file}: INSERT INTO ${b.table} declares ${b.cols} columns but supplies ${b.values} values\n    columns: ${b.colNames.join(", ")}\n    values:  ${b.valueList}`)
    .join("\n");
  assert.equal(bad.length, 0, `column/value arity mismatch:\n${detail}`);
});

test("no INSERT declares a duplicate column", () => {
  const files = walk("src");
  const inserts = files.flatMap((f) => findInserts(f, readFileSync(f, "utf8")));
  const dupes: string[] = [];
  for (const i of inserts) {
    const seen = new Set<string>();
    for (const c of i.colNames) {
      const k = c.toLowerCase();
      if (seen.has(k)) dupes.push(`${i.file}: INSERT INTO ${i.table} lists "${c}" twice`);
      seen.add(k);
    }
  }
  assert.deepEqual(dupes, [], dupes.join("\n"));
});

test("columns written by an INSERT exist in some migration", () => {
  // Catches a typo'd or never-migrated column name, which mysql2 would only surface at runtime.
  const migDir = "db/migrations";
  const migSql = readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(migDir, f), "utf8"))
    .join("\n")
    .toLowerCase();

  // schema_migrations is the runner's own bookkeeping table, created by CREATE TABLE IF NOT EXISTS
  // inside src/db/migrate.ts rather than by a migration file (it has to exist before any migration
  // can be recorded), so it is legitimately absent from the corpus.
  const SELF_MANAGED = new Set(["schema_migrations"]);

  const inserts = walk("src")
    .flatMap((f) => findInserts(f, readFileSync(f, "utf8")))
    .filter((i) => !SELF_MANAGED.has(i.table.toLowerCase()));
  const missing: string[] = [];
  for (const i of inserts) {
    for (const c of i.colNames) {
      const name = c.toLowerCase();
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue; // expression, not a bare column
      // A column is legitimate if it appears anywhere in the migration corpus (CREATE or ALTER).
      if (!new RegExp(`\\b${name}\\b`).test(migSql)) {
        missing.push(`${i.file}: INSERT INTO ${i.table} writes "${c}", which no migration defines`);
      }
    }
  }
  assert.deepEqual(missing, [], missing.join("\n"));
});

// The guard's own correctness. A scanner that silently matches nothing would make the tests above
// pass forever while guarding nothing, so pin both directions on synthetic sources.
test("the scanner detects a real arity mismatch and accepts a correct one", () => {
  const bad = `await conn.execute(\`INSERT INTO t (a, b, c) VALUES (?,?)\`, [x, y]);`;
  const found = findInserts("synthetic.ts", bad);
  assert.equal(found.length, 1, "should have matched the INSERT");
  assert.equal(found[0]!.cols, 3);
  assert.equal(found[0]!.values, 2, "must notice the missing value");

  // Correct SQL that mixes literals and function calls must NOT be flagged.
  const good = `\`INSERT INTO t (a, b, c, d, e) VALUES (?,?,'position',NOW(),COALESCE(?,0))\``;
  const g = findInserts("synthetic.ts", good);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.cols, 5);
  assert.equal(g[0]!.values, 5, "literals, NOW() and COALESCE(?,0) each count as one value");

  // A type declaration with a paren'd type must not break column splitting.
  const typed = `\`INSERT INTO t (a, b) VALUES (?, CAST(? AS DECIMAL(6,2)))\``;
  const t = findInserts("synthetic.ts", typed);
  assert.equal(t[0]!.cols, 2);
  assert.equal(t[0]!.values, 2, "DECIMAL(6,2) must not split on its inner comma");

  // INSERT..SELECT has no VALUES row and must be skipped, not misreported.
  const sel = `\`INSERT INTO t (a, b) SELECT x, y FROM u\``;
  assert.equal(findInserts("synthetic.ts", sel).length, 0);
});

// Enum drift between a TypeScript union and the column that stores it. The sqlarity checks above
// verify a column EXISTS, but not that a value is permitted, and that gap let kind='admin_probe'
// ship while tx_outbox.kind topped out at 'announce', so every remote-admin probe failed at INSERT
// and the feature was inert from the day it landed.
test("every TxKind value is permitted by the tx_outbox.kind ENUM", () => {
  const enc = readFileSync("src/meshtastic/encode.ts", "utf8");
  const union = enc.match(/export type TxKind\s*=([^;]+);/);
  assert.ok(union, "TxKind union not found");
  const kinds = [...union[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(kinds.length >= 5, `expected several TxKind values, got ${kinds.length}`);

  // The effective ENUM is the LAST definition across migrations in filename order, scoped to the
  // tx_outbox statement it belongs to. A bare /kind\s+ENUM/ scan was ambiguous: `kind` is a
  // perfectly ordinary column name, and the moment another table declared one (sensor_event) the
  // guard silently started checking the wrong ENUM and failed with a confusing message.
  const migs = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
  let allowed: string[] | null = null;
  for (const f of migs) {
    const sql = readFileSync(join("db/migrations", f), "utf8");
    // Split into statements and keep only those that name tx_outbox, so a `kind ENUM(...)` on any
    // other table cannot be mistaken for this one.
    for (const stmt of sql.split(";")) {
      if (!/tx_outbox/i.test(stmt)) continue;
      for (const m of stmt.matchAll(/kind\s+ENUM\(([^)]*)\)/gi)) {
        allowed = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
      }
    }
  }
  assert.ok(allowed, "no tx_outbox.kind ENUM definition found in migrations");
  const missing = kinds.filter((k) => !allowed!.includes(k));
  assert.deepEqual(missing, [], `TxKind values with no ENUM slot: ${missing.join(", ")}`);
});
