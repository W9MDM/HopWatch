import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isUpdateAvailable } from "../src/lib/updatecheck.ts";

test("compareVersions orders semver-ish strings numerically", () => {
  assert.equal(compareVersions("0.2.40", "0.2.39"), 1);
  assert.equal(compareVersions("0.2.39", "0.2.40"), -1);
  assert.equal(compareVersions("0.2.39", "0.2.39"), 0);
  assert.equal(compareVersions("0.3.0", "0.2.99"), 1, "minor beats a high patch");
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1, "major beats minor/patch");
  assert.equal(compareVersions("0.2.9", "0.2.10"), -1, "numeric, not lexical");
});

test("compareVersions tolerates a leading v and a pre-release suffix", () => {
  assert.equal(compareVersions("v0.2.40", "0.2.39"), 1);
  assert.equal(compareVersions("0.2.40-rc1", "0.2.40"), 0, "pre-release suffix ignored for ordering");
});

test("isUpdateAvailable only when latest is strictly newer", () => {
  assert.equal(isUpdateAvailable("0.2.40", "0.2.39"), true);
  assert.equal(isUpdateAvailable("0.2.39", "0.2.39"), false);
  assert.equal(isUpdateAvailable("0.2.38", "0.2.39"), false, "older release is not an update");
  assert.equal(isUpdateAvailable(null, "0.2.39"), false, "no release = no update");
  assert.equal(isUpdateAvailable("", "0.2.39"), false);
});
