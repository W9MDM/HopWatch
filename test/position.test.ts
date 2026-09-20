import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rssiToDistanceKm, buildPairEvidence, estimatePosition, isZeroHopDistanceEvidence,
  type RawReception, type EstimateParams,
} from "../src/lib/position.ts";
import { haversineKm, destinationPoint, type LatLon } from "../src/lib/geo.ts";

const PARAMS: EstimateParams = { pathLossExponent: 2.7, referenceLossDb1km: 100, mobileVarianceThresholdDb: 12 };

// Inverse of the model used by rssiToDistanceKm (EIRP 30, ref 100 @ 1km, n=2.7):
// rssi = 30 - (100 + 10*n*log10(d_km)).
function rssiForDistanceKm(d: number): number {
  return 30 - (PARAMS.referenceLossDb1km + 10 * PARAMS.pathLossExponent * Math.log10(d));
}

// Build `count` zero-hop direct receptions of a node at a receiver placed `distKm` away
// on the given bearing from the true position, at the model RSSI plus optional jitter.
function receptionsFrom(truth: LatLon, gatewayId: number, distKm: number, bearingDeg: number, count: number, jitter = 0): RawReception[] {
  const receiver = destinationPoint(truth, bearingDeg, distKm);
  const baseRssi = rssiForDistanceKm(distKm);
  return Array.from({ length: count }, (_, i) => ({
    gatewayId,
    lat: receiver.lat,
    lon: receiver.lon,
    rssi: baseRssi + (jitter ? (i % 2 ? jitter : -jitter) : 0),
    hopStart: 3,
    hopLimit: 3, // zero hops
    receptionClass: "rf_direct",
  }));
}

test("rssiToDistanceKm inverts the path-loss model and is monotonic", () => {
  assert.ok(Math.abs(rssiToDistanceKm(rssiForDistanceKm(1), PARAMS) - 1) < 1e-6);
  assert.ok(Math.abs(rssiToDistanceKm(rssiForDistanceKm(5), PARAMS) - 5) < 1e-6);
  // Weaker signal => farther.
  assert.ok(rssiToDistanceKm(-90, PARAMS) > rssiToDistanceKm(-70, PARAMS));
});

test("tier 3: three known receivers multilaterate within the claimed radius", () => {
  const truth = { lat: 41.6, lon: -85.0 };
  const recs = [
    ...receptionsFrom(truth, 10, 2.0, 0, 8),
    ...receptionsFrom(truth, 11, 3.0, 120, 8),
    ...receptionsFrom(truth, 12, 2.5, 240, 8),
  ];
  const pairs = buildPairEvidence(recs, 5);
  assert.equal(pairs.length, 3);
  const est = estimatePosition(pairs, PARAMS);
  assert.ok(est);
  assert.equal(est!.tier, 3);
  assert.equal(est!.receiverCount, 3);
  const offM = haversineKm(truth, { lat: est!.lat, lon: est!.lon }) * 1000;
  assert.ok(offM <= est!.radiusM, `estimate ${offM.toFixed(0)}m should be within radius ${est!.radiusM.toFixed(0)}m`);
});

test("tier 1: one receiver places at the receiver with an RSSI-implied (generous) radius", () => {
  const truth = { lat: 41.6, lon: -85.0 };
  const recs = receptionsFrom(truth, 20, 3.0, 45, 6);
  const pairs = buildPairEvidence(recs, 5);
  const est = estimatePosition(pairs, PARAMS)!;
  assert.equal(est.tier, 1);
  // Radius reflects the ~3 km plausible range, not a fixed small circle.
  assert.ok(est.radiusM > 2500, `tier-1 radius ${est.radiusM.toFixed(0)}m should reflect the plausible range`);
  const offM = haversineKm(truth, { lat: est.lat, lon: est.lon }) * 1000;
  assert.ok(offM <= est.radiusM + 1, "true position lies within the tier-1 circle");
});

test("tier 2: two receivers yield a weighted point covering both range estimates", () => {
  const truth = { lat: 41.6, lon: -85.0 };
  const recs = [...receptionsFrom(truth, 30, 2.0, 90, 6), ...receptionsFrom(truth, 31, 2.0, 270, 6)];
  const pairs = buildPairEvidence(recs, 5);
  const est = estimatePosition(pairs, PARAMS)!;
  assert.equal(est.tier, 2);
  const offM = haversineKm(truth, { lat: est.lat, lon: est.lon }) * 1000;
  assert.ok(offM <= est.radiusM, `tier-2 estimate ${offM.toFixed(0)}m within radius ${est.radiusM.toFixed(0)}m`);
});

test("relayed receptions are excluded and cannot pull the estimate", () => {
  const truth = { lat: 41.6, lon: -85.0 };
  const good = [
    ...receptionsFrom(truth, 10, 2.0, 0, 8),
    ...receptionsFrom(truth, 11, 3.0, 120, 8),
    ...receptionsFrom(truth, 12, 2.5, 240, 8),
  ];
  // A distant receiver hears the node only relayed, with a deceptively strong RSSI that
  // (if wrongly treated as a distance) would drag the estimate ~100 km away.
  const farReceiver = destinationPoint(truth, 90, 100);
  const relayed: RawReception[] = Array.from({ length: 20 }, () => ({
    gatewayId: 99, lat: farReceiver.lat, lon: farReceiver.lon, rssi: -60,
    hopStart: 3, hopLimit: 1, receptionClass: "rf_relayed",
  }));

  const pairs = buildPairEvidence([...good, ...relayed], 5);
  assert.ok(!pairs.some((p) => p.gatewayId === 99), "relayed-only receiver must not become an evidence pair");

  const est = estimatePosition(pairs, PARAMS)!;
  const offM = haversineKm(truth, { lat: est.lat, lon: est.lon }) * 1000;
  assert.ok(offM < 2000, `estimate stayed near truth (${offM.toFixed(0)}m), not pulled toward the relayed receiver`);
});

test("isZeroHopDistanceEvidence rejects relayed / hopped / rssi-less rows", () => {
  assert.equal(isZeroHopDistanceEvidence({ gatewayId: 1, lat: 0, lon: 0, rssi: -80, hopStart: 3, hopLimit: 3, receptionClass: "rf_direct" }), true);
  assert.equal(isZeroHopDistanceEvidence({ gatewayId: 1, lat: 0, lon: 0, rssi: -80, hopStart: 3, hopLimit: 1, receptionClass: "rf_relayed" }), false);
  assert.equal(isZeroHopDistanceEvidence({ gatewayId: 1, lat: 0, lon: 0, rssi: -80, hopStart: 3, hopLimit: 2, receptionClass: "rf_direct" }), false);
  assert.equal(isZeroHopDistanceEvidence({ gatewayId: 1, lat: 0, lon: 0, rssi: null, hopStart: 3, hopLimit: 3, receptionClass: "rf_direct" }), false);
});

test("buildPairEvidence drops pairs below the minimum reception count", () => {
  const truth = { lat: 41.6, lon: -85.0 };
  const recs = [...receptionsFrom(truth, 10, 2.0, 0, 8), ...receptionsFrom(truth, 11, 3.0, 120, 3)];
  const pairs = buildPairEvidence(recs, 5);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.gatewayId, 10);
});

test("high per-pair RSSI variance flags the node mobile and widens the radius", () => {
  const truth = { lat: 41.6, lon: -85.0 };
  const geometry = (jitter: number) => [
    ...receptionsFrom(truth, 10, 2.0, 0, 8, jitter),
    ...receptionsFrom(truth, 11, 3.0, 120, 8, jitter),
    ...receptionsFrom(truth, 12, 2.5, 240, 8, jitter),
  ];
  const steady = estimatePosition(buildPairEvidence(geometry(0), 5), PARAMS)!;
  const jumpy = estimatePosition(buildPairEvidence(geometry(20), 5), PARAMS)!; // std ~20 dB > 12 dB threshold
  assert.equal(steady.possiblyMobile, false);
  assert.equal(jumpy.possiblyMobile, true);
  assert.ok(jumpy.radiusM > steady.radiusM, "mobile flag widens the radius");
});

// ---------------------------------------------------------------------------
// The antimeridian. Longitude is circular, so plain arithmetic on it breaks at +/-180.
// ---------------------------------------------------------------------------

test("a two-receiver estimate straddling the antimeridian stays in Fiji", async () => {
  const { wrapLon, meanLon, toLocalMeters, haversineKm } = await import("../src/lib/geo.ts");
  assert.ok(Math.abs(wrapLon(359.8) - -0.2) < 1e-9, `${wrapLon(359.8)}`);
  assert.equal(wrapLon(-181), 179);
  assert.equal(wrapLon(180), -180);
  assert.equal(wrapLon(0), 0);
  assert.equal(wrapLon(90), 90);

  // Fiji spans 177E to 178W, so two real gateways can sit either side of the line.
  const west = 179.9, east = -179.9;
  const mean = meanLon([west, east]);
  assert.ok(Math.abs(Math.abs(mean) - 180) < 0.001, `circular mean should be near +/-180, got ${mean}`);
  // The arithmetic mean is 0: the Gulf of Guinea, ~20000 km from either input.
  assert.notEqual(Math.round(mean), 0);

  // And the local projection sees them as the ~22 km apart that they are, not 4e7 m.
  const ref = { lat: -18.1, lon: mean };
  const a = toLocalMeters({ lat: -18.1, lon: west }, ref);
  const b = toLocalMeters({ lat: -18.1, lon: east }, ref);
  const sepM = Math.hypot(a.x - b.x, a.y - b.y);
  const trueKm = haversineKm({ lat: -18.1, lon: west }, { lat: -18.1, lon: east });
  assert.ok(Math.abs(sepM / 1000 - trueKm) < 0.5, `projected ${sepM / 1000} km vs true ${trueKm} km`);
});

test("the local projection round-trips across the antimeridian", async () => {
  const { toLocalMeters, fromLocalMeters } = await import("../src/lib/geo.ts");
  const ref = { lat: -18.1, lon: 179.95 };
  for (const p of [{ lat: -18.1, lon: -179.9 }, { lat: -18.2, lon: 179.8 }, { lat: -18.0, lon: -179.99 }]) {
    const { x, y } = toLocalMeters(p, ref);
    const back = fromLocalMeters(x, y, ref);
    assert.ok(Math.abs(back.lat - p.lat) < 1e-6, `lat ${back.lat} vs ${p.lat}`);
    assert.ok(Math.abs(back.lon - p.lon) < 1e-6, `lon ${back.lon} vs ${p.lon}`);
    assert.ok(back.lon >= -180 && back.lon <= 180, "longitude stays normalized");
  }
});
