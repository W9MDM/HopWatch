import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageRadiusKm, effectiveHeightM, effectiveEirpDbm, predictedRssiDbm, planSite, type CoverageParams } from "../src/lib/coverage.ts";
import { haversineKm } from "../src/lib/geo.ts";

const P: CoverageParams = {
  defaultEirpDbm: 30, defaultHeightM: 8, rxHeightM: 2, rxSensitivityDbm: -128,
  pathLossExponent: 2.7, referenceLossDb1km: 100, maxRadiusKm: 60,
};

test("effective height uses the override or the default, never GPS altitude", () => {
  assert.equal(effectiveHeightM({ heightM: 61, altitudeM: 300 }, P), 61);
  // GPS altitude is metres above MSL (mesh.proto), not height above the ground under the antenna,
  // which is what the radio-horizon term needs. Using it let terrain elevation masquerade as
  // antenna height: a handheld on the ground in Denver reports 1600 m, which yields a 170 km
  // horizon and a ring limited only by the max-radius clamp, while the same radio at sea level
  // draws 17.5 km.
  assert.equal(effectiveHeightM({ altitudeM: 40 }, P), 8, "altitude is ignored");
  assert.equal(effectiveHeightM({ altitudeM: 1600 }, P), 8, "a mile-high city is not a mile-high mast");
  assert.equal(effectiveHeightM({}, P), 8);
  assert.equal(effectiveHeightM({ heightM: 0 }, P), 1, "clamped to >=1");
});

test("a node's elevation no longer inflates its coverage ring", () => {
  const denver = coverageRadiusKm({ altitudeM: 1600 }, P);
  const seaLevel = coverageRadiusKm({ altitudeM: 2 }, P);
  assert.equal(denver, seaLevel, "identical radios draw identical rings regardless of elevation");
  // A real antenna-height override still does extend the ring, which is the intended control.
  assert.ok(coverageRadiusKm({ heightM: 60 }, P) > seaLevel);
});

test("effective EIRP: override wins, else default", () => {
  assert.equal(effectiveEirpDbm({ eirpDbm: 22 }, P), 22);
  assert.equal(effectiveEirpDbm({}, P), 30);
});

test("a taller tower reaches farther (horizon-limited)", () => {
  const low = coverageRadiusKm({ heightM: 3 }, P);
  const tower = coverageRadiusKm({ heightM: 61 }, P); // ~200 ft
  assert.ok(tower > low, `tower ${tower.toFixed(1)}km should exceed 3m node ${low.toFixed(1)}km`);
  assert.ok(tower > 25 && tower < 60, `~200ft tower radius plausible, got ${tower.toFixed(1)}km`);
});

test("radius is clamped to maxRadiusKm", () => {
  assert.ok(coverageRadiusKm({ heightM: 100000 }, P) <= P.maxRadiusKm);
});

test("higher EIRP never reduces coverage", () => {
  const a = coverageRadiusKm({ heightM: 10, eirpDbm: 20 }, P);
  const b = coverageRadiusKm({ heightM: 10, eirpDbm: 30 }, P);
  assert.ok(b >= a);
});

test("predicted RSSI weakens with distance and equals EIRP-ref at 1km", () => {
  assert.equal(Math.round(predictedRssiDbm(1, 30, P)), 30 - 100);
  assert.ok(predictedRssiDbm(10, 30, P) < predictedRssiDbm(1, 30, P));
});

test("site planner: flags in-range nodes and coverage-gap nodes it would newly cover", () => {
  const candidate = { lat: 41.7, lon: -86.9, eirpDbm: 30, heightM: 30 };
  const nodes = [
    { node_id: 1, latitude: 41.71, longitude: -86.9, direct_gateways: 0 }, // ~1km, a gap
    { node_id: 2, latitude: 41.7, longitude: -86.89, direct_gateways: 3 }, // close, already redundant
    { node_id: 3, latitude: 43.5, longitude: -86.9, direct_gateways: 0 }, // ~200km, out of range
  ];
  const plan = planSite(candidate, nodes, P, haversineKm);
  const byId = new Map(plan.predictions.map((x) => [x.node_id, x]));
  assert.equal(byId.get(1)!.in_range, true);
  assert.equal(byId.get(1)!.newly_covered, true, "gap node in range is newly covered");
  assert.equal(byId.get(2)!.newly_covered, false, "already-redundant node is not newly covered");
  assert.equal(byId.get(3)!.in_range, false, "far node is out of range");
  assert.equal(plan.predictions[0]!.node_id, plan.predictions[0]!.node_id, "sorted nearest first");
  assert.ok(plan.predictions[0]!.distance_km <= plan.predictions[plan.predictions.length - 1]!.distance_km);
});

// ---------------------------------------------------------------------------
// First Fresnel-zone radius. Standard form r = 17.32*sqrt(d1*d2/(f*D)) with km/GHz/m.
// The code previously used 8.657 (half of 17.32) in the general formula AND divided the
// midpoint case by 2 again, so the zone was half its true height and terrain that genuinely
// intruded read as clear, making obstruction detection systematically optimistic.
// ---------------------------------------------------------------------------

test("fresnel midpoint radius matches the closed-form 8.66*sqrt(D/f)", async () => {
  const { fresnelMaxM } = await import("../src/lib/los.ts");
  // 10 km at 915 MHz: 17.32*sqrt(2.5*2.5/(0.915*10)) = 8.66*sqrt(10/0.915) ~= 28.63 m
  const r = fresnelMaxM(10, 0.915);
  assert.ok(Math.abs(r - 28.63) < 0.05, `expected ~28.63 m, got ${r}`);
  // The old halved constant would have produced ~14.3 m.
  assert.ok(r > 20, "must not be the halved value");
});

test("fresnel radius is widest at the midpoint and zero at the endpoints", async () => {
  const { fresnelRadiusM, fresnelMaxM } = await import("../src/lib/los.ts");
  const D = 12, f = 0.915;
  assert.equal(fresnelRadiusM(0, D, D, f), 0, "zero at endpoint a");
  assert.equal(fresnelRadiusM(D, 0, D, f), 0, "zero at endpoint b");
  const mid = fresnelRadiusM(D / 2, D / 2, D, f);
  assert.ok(Math.abs(mid - fresnelMaxM(D, f)) < 1e-9, "midpoint equals fresnelMaxM");
  // Monotonic rise toward the middle.
  assert.ok(fresnelRadiusM(1, D - 1, D, f) < fresnelRadiusM(3, D - 3, D, f));
  assert.ok(fresnelRadiusM(3, D - 3, D, f) < mid);
});

test("fresnel radius grows with distance and shrinks with frequency", async () => {
  const { fresnelMaxM } = await import("../src/lib/los.ts");
  assert.ok(fresnelMaxM(20, 0.915) > fresnelMaxM(10, 0.915), "longer path, bigger zone");
  assert.ok(fresnelMaxM(10, 2.4) < fresnelMaxM(10, 0.915), "higher frequency, smaller zone");
});

test("fresnel radius degenerates safely instead of returning NaN", async () => {
  const { fresnelRadiusM, fresnelMaxM } = await import("../src/lib/los.ts");
  assert.equal(fresnelRadiusM(1, 1, 0, 0.915), 0, "zero distance");
  assert.equal(fresnelRadiusM(1, 1, 10, 0), 0, "zero frequency");
  assert.equal(fresnelMaxM(0, 0.915), 0);
  // A negative product (bad inputs) must clamp, not produce NaN through sqrt.
  assert.ok(Number.isFinite(fresnelRadiusM(-5, 5, 10, 0.915)));
});
