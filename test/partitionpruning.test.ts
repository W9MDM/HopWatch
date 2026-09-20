import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// Static guard: never wrap a partitioning key in a function inside a WHERE clause.
//
// The hot tables are RANGE COLUMNS partitioned by a datetime (see db/migrations/0001_init.sql and
// src/db/partitions.ts). MySQL can prune partitions only when the predicate compares the bare
// column, so `WHERE DATE(bucket_start) < ?` forces a full scan of every surviving partition, and
// nothing about it looks wrong at the call site. The daily rollup did exactly that with no lower
// bound either, so every 30-minute tick re-scanned up to a year of hourly rollups and rewrote every
// historical day row for every (gateway, node) pair. Compare the raw column against a range instead:
// `WHERE bucket_start >= ? AND bucket_start < ?`.
//
// This is a compile-time-invisible performance cliff that grows silently with retention, which is
// exactly the kind of thing a static guard is for.

/** Datetime columns that are a partitioning key on some table. */
const PARTITION_KEYS = ["rx_time", "bucket_start", "first_seen_at", "stored_at", "observed_at"];
const WRAPPERS = ["DATE", "DATE_FORMAT", "YEAR", "MONTH", "DAY", "HOUR", "UNIX_TIMESTAMP", "CAST"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules" && e !== ".next") sourceFiles(p, out);
    } else if (p.endsWith(".ts") || p.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

/** Drop JS comments so prose describing the anti-pattern is not itself a hit. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(\/\/|\*).*$/gm, "");
}

test("no WHERE clause wraps a partitioning key in a function", () => {
  const keys = PARTITION_KEYS.join("|");
  const wrappers = WRAPPERS.join("|");
  // A WHERE/AND/OR fragment that applies one of the wrappers to a (possibly aliased) partition key.
  const pattern = new RegExp(`\\b(WHERE|AND|OR)\\b[^)]{0,80}?\\b(${wrappers})\\s*\\(\\s*(?:\\w+\\.)?(${keys})\\b`, "i");
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const line of src.split("\n")) {
      const m = pattern.exec(line);
      if (m) offenders.push(`${file.split(sep).join("/")}: ${m[2]}(${m[3]}) in a ${m[1]!.toUpperCase()} clause`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `compare the bare column against a range so partitions prune:\n  ${offenders.join("\n  ")}`,
  );
});

test("the guard's pattern actually matches the anti-pattern (it is not vacuous)", () => {
  const keys = PARTITION_KEYS.join("|");
  const wrappers = WRAPPERS.join("|");
  const pattern = new RegExp(`\\b(WHERE|AND|OR)\\b[^)]{0,80}?\\b(${wrappers})\\s*\\(\\s*(?:\\w+\\.)?(${keys})\\b`, "i");
  // The exact shape the daily rollup used before it was fixed.
  assert.ok(pattern.test("FROM reception_rollup_hour WHERE DATE(bucket_start) < ?"));
  assert.ok(pattern.test("WHERE gateway_id=? AND DATE_FORMAT(rx_time, '%Y') = ?"));
  // ...and does not flag the correct form, nor a function on a non-partition column.
  assert.ok(!pattern.test("WHERE bucket_start >= ? AND bucket_start < ?"));
  assert.ok(!pattern.test("WHERE rx_time >= ? AND rx_time < ?"));
  assert.ok(!pattern.test("SELECT DATE_FORMAT(bucket_start,'%Y-%m-%d') AS bucket FROM node_rollup_hour"));
  assert.ok(!pattern.test("WHERE DATE(created_at) = ?"), "created_at is not a partitioning key");
});
