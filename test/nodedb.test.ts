import { test } from "node:test";
import assert from "node:assert/strict";
import { planNodeDbPrune } from "../src/lib/nodedb.ts";

const NOW = 1_800_000_000; // fixed "now" in unix seconds
const day = 86400;

test("planNodeDbPrune favorites repeaters/routers and removes only stale non-infra nodes", () => {
  const nodes = [
    { num: 1, role: "CLIENT", last_heard: NOW - 1 * day },       // recent client -> keep
    { num: 2, role: "CLIENT", last_heard: NOW - 30 * day },      // stale client -> remove
    { num: 3, role: "ROUTER", last_heard: NOW - 60 * day },      // stale ROUTER -> favorite (never remove)
    { num: 4, role: "REPEATER", last_heard: NOW - 2 * day },     // repeater -> favorite
    { num: 5, role: "CLIENT", last_heard: 0 },                   // never heard -> remove
    { num: 9, role: "CLIENT", last_heard: NOW - 90 * day },      // self -> keep despite stale
  ];
  const plan = planNodeDbPrune(nodes, 9, { staleDays: 7, favoriteRepeaters: true, nowSec: NOW });
  assert.deepEqual(plan.favorite.sort(), [3, 4]);
  assert.deepEqual(plan.remove.sort(), [2, 5]);
  assert.deepEqual(plan.keep.sort(), [1, 9]);
});

test("repeaterNums forces infra classification even when the node reports CLIENT", () => {
  const nodes = [{ num: 7, role: "CLIENT", last_heard: NOW - 40 * day }];
  const plan = planNodeDbPrune(nodes, 9, { staleDays: 7, favoriteRepeaters: true, repeaterNums: [7], nowSec: NOW });
  assert.deepEqual(plan.favorite, [7]);
  assert.deepEqual(plan.remove, []);
});

test("favoriteRepeaters=false keeps infra without favoriting", () => {
  const nodes = [{ num: 3, role: "ROUTER", last_heard: NOW - 60 * day }];
  const plan = planNodeDbPrune(nodes, 9, { staleDays: 7, favoriteRepeaters: false, nowSec: NOW });
  assert.deepEqual(plan.favorite, []);
  assert.deepEqual(plan.keep, [3]);
});
