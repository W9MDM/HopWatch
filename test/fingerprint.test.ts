import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFingerprint } from "../src/lib/fingerprint.ts";

test("empty input -> insufficient data", () => {
  const fp = buildFingerprint([]);
  assert.equal(fp.total, 0);
  assert.equal(fp.profile, "insufficient data");
  assert.equal(fp.grid.length, 7);
  assert.equal(fp.grid[0]!.length, 24);
});

test("activity concentrated in a 12h window -> solar day-cycler", () => {
  const rows: { dow: number; hour: number; c: number }[] = [];
  for (let d = 0; d < 7; d++) for (let h = 8; h < 18; h++) rows.push({ dow: d, hour: h, c: 5 });
  const fp = buildFingerprint(rows);
  assert.equal(fp.profile, "solar day-cycler");
  assert.ok(fp.peak12hShare > 0.72);
});

test("spread across all 24 hours at modest rate -> always-on", () => {
  const rows: { dow: number; hour: number; c: number }[] = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) rows.push({ dow: d, hour: h, c: 3 });
  const fp = buildFingerprint(rows);
  assert.equal(fp.activeHours, 24);
  assert.equal(fp.profile, "always-on");
});

test("very high rate -> aggressive beaconer", () => {
  const rows: { dow: number; hour: number; c: number }[] = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) rows.push({ dow: d, hour: h, c: 200 });
  const fp = buildFingerprint(rows);
  assert.equal(fp.profile, "aggressive beaconer");
  assert.ok(fp.avgPerActiveHour > 60);
});

test("grid accumulates counts at the right cell", () => {
  const fp = buildFingerprint([{ dow: 3, hour: 14, c: 9 }]);
  assert.equal(fp.grid[3]![14], 9);
  assert.equal(fp.total, 9);
  assert.equal(fp.max, 9);
});
