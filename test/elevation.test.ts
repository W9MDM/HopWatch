import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsgsSamples, parseOpenElevation, normalizeSource } from "../src/lib/elevation.ts";

test("normalizeSource defaults to usgs_3dep and only accepts the known alternative", () => {
  assert.equal(normalizeSource(undefined), "usgs_3dep");
  assert.equal(normalizeSource(""), "usgs_3dep");
  assert.equal(normalizeSource("nonsense"), "usgs_3dep");
  assert.equal(normalizeSource("open_elevation"), "open_elevation");
});

test("USGS getSamples values are re-seated by locationId regardless of return order", () => {
  // getSamples returns samples out of order; value is a string; locationId indexes the input.
  const json = {
    samples: [
      { locationId: 2, value: "199.3" },
      { locationId: 0, value: "242.4" },
      { locationId: 1, value: "239.1" },
    ],
  };
  assert.deepEqual(parseUsgsSamples(json, 3), [242.4, 239.1, 199.3]);
});

test("USGS parse leaves missing locations null and rejects out-of-band no-data", () => {
  const json = {
    samples: [
      { locationId: 0, value: "100" },
      { locationId: 1, value: "-1000000" }, // 3DEP no-data sentinel: outside the plausible band
      // locationId 2 absent entirely
      { locationId: 9, value: "50" }, // out of range for n=3, ignored
    ],
  };
  assert.deepEqual(parseUsgsSamples(json, 3), [100, null, null]);
});

test("USGS parse tolerates a malformed response", () => {
  assert.deepEqual(parseUsgsSamples(null, 2), [null, null]);
  assert.deepEqual(parseUsgsSamples({}, 2), [null, null]);
  assert.deepEqual(parseUsgsSamples({ samples: "nope" }, 2), [null, null]);
});

test("open-elevation results are read in request order with band validation", () => {
  const json = { results: [{ elevation: 180 }, { elevation: 999999 }, { elevation: 200 }] };
  assert.deepEqual(parseOpenElevation(json, 3), [180, null, 200]);
});

test("open-elevation parse handles short or malformed results", () => {
  assert.deepEqual(parseOpenElevation({ results: [{ elevation: 10 }] }, 3), [10, null, null]);
  assert.deepEqual(parseOpenElevation(null, 2), [null, null]);
});
