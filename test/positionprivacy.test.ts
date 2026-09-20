import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Static guard for a bug class no type can catch: a surface that emits node coordinates but never
// applies server.privacy.fuzz_positions.
//
// The setting is documented as covering "the maps and public API", and /map, /livemap and /coverage
// honoured it, but /api/v1/history, /api/v1/replay, /api/v1/nodes/{id}, /nodes/{id}, /replay and
// /site-planner all shipped exact coordinates to anonymous callers, several of them with a
// multi-hundred-point movement history. Nothing about that is visible at a call site: the query
// returns plain numbers and the route just serializes them.
//
// So: any file under src/app that reads a coordinate-bearing query must also resolve the fuzz
// decimals for the request. Adding a new position surface without the policy fails here.

const COORD_QUERIES = [
  "getMapNodes",
  "getMapAt",
  "getEstimatedMapNodes",
  "getReplayData",
  "getCoverage",
  "getNode",
  "getNodeBiography",
  "nodePositionTrack",
  "getLivemapData",
];

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

/** Strip line and block comments so a query named only in prose does not count as a read. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("every src/app surface that reads coordinates also applies the fuzz policy", () => {
  const offenders: string[] = [];
  for (const file of walk(join("src", "app"))) {
    const src = stripComments(readFileSync(file, "utf8"));
    const used = COORD_QUERIES.filter((q) => new RegExp(`\\b${q}\\s*\\(`).test(src));
    if (used.length === 0) continue;
    if (!src.includes("fuzzDecimalsFor")) {
      offenders.push(`${file.replace(/\\/g, "/")} reads ${used.join(", ")} but never calls fuzzDecimalsFor`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `position-bearing surfaces must honour server.privacy.fuzz_positions:\n  ${offenders.join("\n  ")}`,
  );
});

test("the guard actually sees the coordinate queries (it is not vacuous)", () => {
  // A guard that matches nothing passes forever. Assert it finds the surfaces we know exist, so a
  // rename of a query or of the app directory cannot quietly disarm it.
  const hits = new Set<string>();
  for (const file of walk(join("src", "app"))) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const q of COORD_QUERIES) if (new RegExp(`\\b${q}\\s*\\(`).test(src)) hits.add(q);
  }
  for (const q of ["getMapAt", "getReplayData", "getCoverage", "getNode", "nodePositionTrack"]) {
    assert.ok(hits.has(q), `${q} is no longer found in src/app: the guard's query list is stale`);
  }
});
