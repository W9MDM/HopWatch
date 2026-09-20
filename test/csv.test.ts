import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "../src/lib/csv.ts";
import { clampLimit } from "../src/db/client.ts";

test("toCsv emits a header row and quotes only when needed", () => {
  const out = toCsv([{ a: 1, b: "plain" }, { a: 2, b: "has,comma" }]);
  const lines = out.trimEnd().split("\n");
  assert.equal(lines[0], "a,b");
  assert.equal(lines[1], "1,plain");
  assert.equal(lines[2], '2,"has,comma"');
});

test("toCsv escapes embedded quotes by doubling them", () => {
  assert.equal(toCsv([{ a: 'say "hi"' }]).trimEnd().split("\n")[1], '"say ""hi"""');
});

test("toCsv with no rows still emits the requested header", () => {
  assert.equal(toCsv([], ["x", "y"]), "x,y\n");
});

// ---------------------------------------------------------------------------
// Spreadsheet formula injection (CWE-1236).
//
// Node identity is attacker-controlled: any radio on the air can set User.long_name/short_name via
// NODEINFO_APP, and mesh.proto allows 40 bytes, which is ample for a DDE or HYPERLINK payload.
// HopWatch stores it verbatim and it reaches operator-clicked exports on /nodes, /packets and
// /gateways/{id}. Quoting does NOT disarm a leading `=`: the importer strips the quotes first.
// ---------------------------------------------------------------------------

test("a formula-leading cell is neutralized with a text marker", () => {
  for (const payload of ['=cmd|\'/c calc\'!A0', "+1+1", "-2+3", "@SUM(A1)", "\tlead", "\rlead"]) {
    const cell = toCsv([{ name: payload }]).trimEnd().split("\n")[1]!;
    assert.ok(cell.startsWith("'") || cell.startsWith('"\''), `not neutralized: ${JSON.stringify(cell)}`);
    assert.ok(!/^"?[=+\-@\t\r]/.test(cell), `still opens with a formula trigger: ${JSON.stringify(cell)}`);
  }
});

test("neutralizing composes with quoting, and leaves ordinary values alone", () => {
  // A payload that ALSO needs quoting must get both, in the right order.
  assert.equal(toCsv([{ n: '=HYPERLINK("http://x","go")' }]).trimEnd().split("\n")[1], `"'=HYPERLINK(""http://x"",""go"")"`);
  // Negative numbers are the obvious false positive to watch: they are values, not formulas, but
  // Excel treats a leading "-" in a text cell as a formula start, so prefixing is still correct and
  // spreadsheets show the number unchanged.
  assert.equal(toCsv([{ n: "plain node" }]).trimEnd().split("\n")[1], "plain node");
  assert.equal(toCsv([{ n: 42 }]).trimEnd().split("\n")[1], "42");
  assert.equal(toCsv([{ n: null }]).split("\n")[1], "", "a null cell is empty, not neutralized");
});

// ---------------------------------------------------------------------------
// LIMIT clamps. Every paging clamp used Math.min(Math.max(x, 1), n), which is NaN-transparent, and
// the result is interpolated straight into the SQL text after LIMIT. So `?limit=abc` became the
// literal `LIMIT NaN`, mysql2 threw at prepare time, and the route returned HTTP 503 carrying the
// MySQL parse error: the wrong status for bad client input, and an echo of the server's SQL.
// ---------------------------------------------------------------------------

test("clampLimit never yields NaN, whatever the caller passes", () => {
  for (const bad of ["abc", "", null, undefined, NaN, {}, [], "1e999x"]) {
    const n = clampLimit(bad, 500, 100);
    assert.ok(Number.isFinite(n), `not finite for ${JSON.stringify(bad)}`);
    assert.equal(n, 100, "falls back to the caller's default");
  }
});

test("clampLimit clamps to the range and floors fractions", () => {
  assert.equal(clampLimit(50, 500), 50);
  assert.equal(clampLimit(0, 500), 1, "LIMIT 0 returns nothing, so 1 is the floor");
  assert.equal(clampLimit(-5, 500), 1);
  assert.equal(clampLimit(99999, 500), 500);
  assert.equal(clampLimit("7.9", 500), 7, "an integer reaches the SQL text, never 7.9");
  assert.equal(clampLimit(Infinity, 500), 500, "Infinity is not finite as an integer either");
});

test("clampLimit defaults to the maximum when no default is given", () => {
  assert.equal(clampLimit("nonsense", 250), 250);
});
