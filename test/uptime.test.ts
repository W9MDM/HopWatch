import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeDeviceUptime, availabilityPct } from "../src/lib/uptime.ts";

test("summarizeDeviceUptime: steady climb has no reboots", () => {
  const s = summarizeDeviceUptime([
    { observed_at: "2026-10-01 00:00:00", value: 100 },
    { observed_at: "2026-10-01 01:00:00", value: 3700 },
    { observed_at: "2026-10-01 02:00:00", value: 7300 },
  ]);
  assert.equal(s.reboots, 0);
  assert.equal(s.lastRebootAt, null);
  assert.equal(s.currentS, 7300);
  assert.equal(s.longestRunS, 7300);
});

test("summarizeDeviceUptime: a counter reset is one reboot, and marks when it came back", () => {
  const s = summarizeDeviceUptime([
    { observed_at: "2026-10-01 00:00:00", value: 500000 },
    { observed_at: "2026-10-01 01:00:00", value: 30 },      // rebooted
    { observed_at: "2026-10-01 02:00:00", value: 3630 },
  ]);
  assert.equal(s.reboots, 1);
  assert.equal(s.lastRebootAt, "2026-10-01 01:00:00");
  assert.equal(s.currentS, 3630);
  assert.equal(s.longestRunS, 500000); // longest observed run survives the reboot
});

test("summarizeDeviceUptime: tiny jitter is not a reboot", () => {
  const s = summarizeDeviceUptime([
    { observed_at: "2026-10-01 00:00:00", value: 1000 },
    { observed_at: "2026-10-01 01:00:00", value: 980 }, // 20s back, within tolerance
  ]);
  assert.equal(s.reboots, 0);
});

test("summarizeDeviceUptime: empty series", () => {
  const s = summarizeDeviceUptime([]);
  assert.equal(s.currentS, null);
  assert.equal(s.reboots, 0);
  assert.equal(s.longestRunS, 0);
});

test("availabilityPct: full window", () => {
  assert.equal(availabilityPct(24, 24, 1000), 100);
  assert.equal(availabilityPct(12, 24, 1000), 50);
});

test("availabilityPct: denominator capped at lifetime for a young node", () => {
  // Seen for only 10 hours, heard in all 10: 100% over a 30d window, not 1%.
  assert.equal(availabilityPct(10, 720, 10), 100);
});

test("availabilityPct: clamped to 0..100 and never divides by zero", () => {
  assert.equal(availabilityPct(5, 24, 0), 100); // lifetime 0 -> denom 1, clamped
  assert.equal(availabilityPct(0, 24, 24), 0);
});
