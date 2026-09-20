import { test } from "node:test";
import assert from "node:assert/strict";
import { networkCondition, CONDITION_STALE_MINUTES } from "../src/lib/condition.ts";

test("network condition maps score to a level when fresh", () => {
  assert.equal(networkCondition(90, 1).label, "Strong");
  assert.equal(networkCondition(75, 1).label, "Good");
  assert.equal(networkCondition(60, 1).label, "Fair");
  assert.equal(networkCondition(45, 1).tone, "warn");
  assert.equal(networkCondition(10, 1).label, "Critical");
  assert.equal(networkCondition(10, 1).tone, "bad");
});

test("stale or missing data reads as Unknown, never falsely green", () => {
  assert.equal(networkCondition(95, CONDITION_STALE_MINUTES + 1).label, "Unknown");
  assert.equal(networkCondition(null, 1).label, "Unknown");
  assert.equal(networkCondition(95, null).tone, "unknown");
});
