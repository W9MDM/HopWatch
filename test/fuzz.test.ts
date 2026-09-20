import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzPositions, fuzzDecimalsFor, fuzzNodeCoords, stripNodePosition, roundCoord } from "../src/lib/fuzz.ts";

test("fuzzPositions rounds lat/lon to the given decimals and copies rows", () => {
  const rows = [{ node_id: 1, latitude: 41.583921, longitude: -87.229144, name: "x" }];
  const out = fuzzPositions(rows, 2);
  assert.equal(out[0]!.latitude, 41.58);
  assert.equal(out[0]!.longitude, -87.23);
  assert.equal(out[0]!.name, "x", "other fields preserved");
  assert.notEqual(out[0], rows[0], "returns a copy, not the original row");
  assert.equal(rows[0]!.latitude, 41.583921, "original is untouched");
});

test("fuzzPositions with null decimals leaves rows exactly as-is", () => {
  const rows = [{ latitude: 41.583921, longitude: -87.229144 }];
  const out = fuzzPositions(rows, null);
  assert.equal(out[0]!.latitude, 41.583921);
  assert.equal(out, rows, "same array reference when fuzzing is off");
});

test("fuzzPositions tolerates null coordinates", () => {
  const out = fuzzPositions([{ latitude: null, longitude: null }], 3);
  assert.equal(out[0]!.latitude, null);
  assert.equal(out[0]!.longitude, null);
});

test("fuzzDecimalsFor: admins and disabled fuzzing yield null (exact)", () => {
  const on = { server: { privacy: { fuzz_positions: true, fuzz_decimals: 2 } } };
  const off = { server: { privacy: { fuzz_positions: false, fuzz_decimals: 2 } } };
  assert.equal(fuzzDecimalsFor(on, false), 2, "non-admin with fuzzing on gets the configured decimals");
  assert.equal(fuzzDecimalsFor(on, true), null, "admin always sees exact positions");
  assert.equal(fuzzDecimalsFor(off, false), null, "fuzzing off = exact");
});

// ---------------------------------------------------------------------------
// The two coordinate pairs a node-detail row carries, and the operator's per-node suppression.
// fuzzPositions only reaches `latitude`/`longitude`, so a node-detail surface that used it alone
// left the estimate exact, which gives the fuzzed GPS pair straight back.
// ---------------------------------------------------------------------------

test("fuzzNodeCoords rounds the estimate pair as well as the GPS pair", () => {
  const node = {
    node_id: 7, latitude: 41.583921, longitude: -87.229144,
    est_latitude: 41.581234, est_longitude: -87.221111, confidence_radius_m: 900, long_name: "n",
  };
  const out = fuzzNodeCoords(node, 2);
  assert.equal(out.latitude, 41.58);
  assert.equal(out.longitude, -87.23);
  assert.equal(out.est_latitude, 41.58, "an unrounded estimate would defeat the rounded GPS pair");
  assert.equal(out.est_longitude, -87.22);
  assert.equal(out.long_name, "n", "other fields preserved");
  assert.equal(node.latitude, 41.583921, "original untouched");
});

test("fuzzNodeCoords with null decimals is a no-op", () => {
  const node = { latitude: 41.583921, est_latitude: 41.581234 };
  assert.equal(fuzzNodeCoords(node, null), node);
});

test("stripNodePosition blanks every position field, including the estimate and has_position", () => {
  const out = stripNodePosition({
    node_id: 7, latitude: 41.58, longitude: -87.22, altitude_m: 210, precision_bits: 32,
    est_latitude: 41.5, est_longitude: -87.2, confidence_radius_m: 900,
    has_position: 1, position_source: "gps", long_name: "n",
  });
  assert.equal(out.latitude, null);
  assert.equal(out.longitude, null);
  assert.equal(out.altitude_m, null);
  assert.equal(out.precision_bits, null);
  assert.equal(out.est_latitude, null, "the estimate is a position too");
  assert.equal(out.est_longitude, null);
  assert.equal(out.confidence_radius_m, null);
  assert.equal(out.has_position, 0);
  assert.equal(out.position_source, null, "so a caller cannot infer a fix exists");
  assert.equal(out.long_name, "n", "only positions are removed");
});

test("roundCoord matches fuzzPositions and passes nulls through", () => {
  assert.equal(roundCoord(-87.229144, 3), -87.229);
  assert.equal(roundCoord(-87.229144, null), -87.229144, "null decimals means exact");
  assert.equal(roundCoord(null, 3), null);
  assert.equal(roundCoord(undefined, 3), null);
});
