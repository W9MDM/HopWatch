import { test } from "node:test";
import assert from "node:assert/strict";
import { touchPresence } from "../src/lib/presence.ts";

// The store is module-level; use a distinct time epoch per test (far apart) so earlier
// entries are expired out and tests stay independent.

test("counts distinct tabs and refreshes without double-counting", () => {
  const t0 = 1_000_000_000_000;
  assert.equal(touchPresence("tab-aaaaaaaa", t0), 1);
  assert.equal(touchPresence("tab-bbbbbbbb", t0 + 1000), 2);
  assert.equal(touchPresence("tab-aaaaaaaa", t0 + 2000), 2, "same tab beaconing again is not a new viewer");
});

test("expires tabs that stopped beaconing past the window", () => {
  const t0 = 2_000_000_000_000;
  touchPresence("tab-cccccccc", t0);
  touchPresence("tab-dddddddd", t0 + 1000);
  // 5 minutes later only the new beacon survives (window is 90s).
  assert.equal(touchPresence("tab-eeeeeeee", t0 + 300_000), 1);
});
