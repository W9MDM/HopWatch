// Position estimation math. Pure and DB-free so it is fully unit-testable with
// synthetic geometry. The worker (src/worker/position.ts) fetches evidence from MySQL
// and calls into here; nothing in this file touches a connection.
//
// This is estimation, not GPS. RSSI-to-distance at 915 MHz with unknown antennas,
// heights, and terrain is rough: expect confidence radii of hundreds of metres to
// several km. The output is deliberately labelled and radius-widened, never precise.
import { haversineKm, toLocalMeters, fromLocalMeters, meanLon, type LatLon } from "./geo.ts";

export interface PathLossParams {
  pathLossExponent: number; // log-distance exponent n
  referenceLossDb1km: number; // path loss at the 1 km reference distance
  txPowerDbm?: number; // assumed EIRP; LoRa default 30 dBm
}

export interface EstimateParams extends PathLossParams {
  mobileVarianceThresholdDb: number; // per-pair RSSI std-dev above which a node is flagged mobile
}

/**
 * Log-distance path loss inverse: median RSSI (dBm) -> distance (km).
 * distance = 10 ^ ((EIRP - rssi - referenceLoss@1km) / (10 * n)).
 * Clamped to a plausible LoRa range so a single wild sample cannot produce a silly circle.
 */
export function rssiToDistanceKm(rssiDbm: number, p: PathLossParams): number {
  const tx = p.txPowerDbm ?? 30;
  const pathLoss = tx - rssiDbm;
  const d = Math.pow(10, (pathLoss - p.referenceLossDb1km) / (10 * p.pathLossExponent));
  return Math.min(60, Math.max(0.01, d));
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Population variance. */
export function variance(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
}

// A single raw reception as fetched from the DB. Relay filtering happens in this module
// (buildPairEvidence), so a wrongly-included relayed row is provably excluded from the math.
export interface RawReception {
  gatewayId: number;
  lat: number; // receiver position (gateway treated as a positioned node)
  lon: number;
  rssi: number | null;
  hopStart: number | null;
  hopLimit: number | null;
  receptionClass?: string | null;
}

export interface PairEvidence {
  gatewayId: number;
  receiver: LatLon;
  medianRssi: number;
  stdDevRssi: number;
  count: number;
}

/**
 * Zero-hop distance evidence only. A relayed reception says nothing about the
 * source-to-receiver distance and MUST NOT feed the distance math:
 *  - explicit rf_relayed class is rejected outright;
 *  - otherwise the reception counts only when hop_start === hop_limit (0 hops);
 *  - if hop metadata is missing we trust only an explicit direct class.
 * RSSI must be present.
 */
export function isZeroHopDistanceEvidence(r: RawReception): boolean {
  if (r.rssi == null) return false;
  if (r.receptionClass === "rf_relayed") return false;
  if (r.hopStart != null && r.hopLimit != null) return r.hopStart === r.hopLimit;
  return r.receptionClass === "rf_direct" || r.receptionClass === "rf_direct_low_conf";
}

/** Group zero-hop receptions by receiver, using median RSSI to resist outliers. */
export function buildPairEvidence(recs: RawReception[], minPerPair: number): PairEvidence[] {
  const byGw = new Map<number, RawReception[]>();
  for (const r of recs) {
    if (!isZeroHopDistanceEvidence(r)) continue;
    const arr = byGw.get(r.gatewayId) ?? [];
    if (arr.length === 0) byGw.set(r.gatewayId, arr);
    arr.push(r);
  }
  const out: PairEvidence[] = [];
  for (const [gatewayId, list] of byGw) {
    if (list.length < minPerPair) continue;
    const rssis = list.map((r) => r.rssi!);
    out.push({
      gatewayId,
      receiver: { lat: list[0]!.lat, lon: list[0]!.lon },
      medianRssi: median(rssis),
      stdDevRssi: Math.sqrt(variance(rssis)),
      count: list.length,
    });
  }
  return out;
}

export interface PositionEstimate {
  lat: number;
  lon: number;
  radiusM: number;
  tier: 1 | 2 | 3;
  receiverCount: number;
  possiblyMobile: boolean;
}

const MIN_RADIUS_M = 250;

/**
 * Estimation ladder. Applies the best method the evidence supports and records the tier:
 *   tier 1 (one receiver)   -> place at the receiver, radius = RSSI-implied range (generous).
 *   tier 2 (two receivers)  -> RSSI-weighted point, radius covering both range estimates.
 *   tier 3 (three or more)  -> weighted least-squares multilateration, radius from residuals.
 * A node whose per-pair RSSI std-dev exceeds the mobile threshold is flagged and its
 * radius widened rather than pretending precision.
 */
export function estimatePosition(pairs: PairEvidence[], p: EstimateParams): PositionEstimate | null {
  if (pairs.length === 0) return null;
  const items = pairs.map((pe) => ({ ...pe, distKm: rssiToDistanceKm(pe.medianRssi, p) }));
  const possiblyMobile = items.some((it) => it.stdDevRssi > p.mobileVarianceThresholdDb);
  const widen = possiblyMobile ? 1.6 : 1.0;
  const receiverCount = items.length;

  // Tier 1: only known constraint is a distance from one receiver; the node lies somewhere
  // on that ring, so the point is the receiver and the radius is the full plausible range.
  if (items.length === 1) {
    const it = items[0]!;
    return {
      lat: it.receiver.lat,
      lon: it.receiver.lon,
      radiusM: Math.max(MIN_RADIUS_M, it.distKm * 1000) * widen,
      tier: 1,
      receiverCount,
      possiblyMobile,
    };
  }

  // Tier 2: weighted point between the two receivers (closer/stronger pulls harder).
  if (items.length === 2) {
    const w = items.map((it) => 1 / Math.max(it.distKm, 0.05));
    const wsum = w[0]! + w[1]!;
    const lat = (items[0]!.receiver.lat * w[0]! + items[1]!.receiver.lat * w[1]!) / wsum;
    // Circular mean: averaging raw longitudes put a pair straddling the antimeridian (179.9 and
    // -179.9, roughly 20 km apart in Fiji) at longitude 0, about 20000 km away.
    const lon = meanLon([items[0]!.receiver.lon, items[1]!.receiver.lon], [w[0]!, w[1]!]);
    const est = { lat, lon };
    const resid = Math.max(...items.map((it) => Math.abs(haversineKm(est, it.receiver) - it.distKm))) * 1000;
    const base = Math.max(...items.map((it) => it.distKm)) * 1000 * 0.5;
    return { lat, lon, radiusM: Math.max(MIN_RADIUS_M, resid, base) * widen, tier: 2, receiverCount, possiblyMobile };
  }

  // Tier 3: weighted least-squares multilateration in a local metric frame.
  const ref: LatLon = {
    lat: items.reduce((a, it) => a + it.receiver.lat, 0) / items.length,
    // Circular, for the same reason: a raw mean would put the local frame's origin in the wrong
    // hemisphere and hand toLocalMeters offsets of ~2e7 m for receivers a few km apart.
    lon: meanLon(items.map((it) => it.receiver.lon)),
  };
  const pts = items.map((it) => ({ ...toLocalMeters(it.receiver, ref), r: it.distKm * 1000, w: it.count / Math.max(it.distKm, 0.1) }));
  // Anchor on the strongest (smallest range) receiver and linearize the range equations.
  let a = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i]!.r < pts[a]!.r) a = i;
  const A = pts[a]!;
  let sxx = 0, sxy = 0, syy = 0, bx = 0, by = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i === a) continue;
    const P = pts[i]!;
    const ax = 2 * (P.x - A.x);
    const ay = 2 * (P.y - A.y);
    const b = P.x ** 2 - A.x ** 2 + P.y ** 2 - A.y ** 2 - (P.r ** 2 - A.r ** 2);
    const w = P.w;
    sxx += w * ax * ax;
    sxy += w * ax * ay;
    syy += w * ay * ay;
    bx += w * ax * b;
    by += w * ay * b;
  }
  const det = sxx * syy - sxy * sxy;
  let localX: number, localY: number;
  // Normalized degeneracy test: det is a difference of meters^4-scale sums, so an absolute
  // threshold (1e-6) only caught EXACTLY collinear inputs and let near-collinear geometry through
  // a near-singular solve, throwing the point far outside the receiver hull. Compare det to the
  // magnitude of its terms instead, so ill-conditioned geometry also falls back to the centroid.
  if (Math.abs(det) < 1e-6 * Math.max(sxx * syy, 1)) {
    // Receivers are (near) collinear: fall back to a weighted centroid.
    const wsum = pts.reduce((s, P) => s + P.w, 0);
    localX = pts.reduce((s, P) => s + P.x * P.w, 0) / wsum;
    localY = pts.reduce((s, P) => s + P.y * P.w, 0) / wsum;
  } else {
    localX = (syy * bx - sxy * by) / det;
    localY = (sxx * by - sxy * bx) / det;
  }
  const est = fromLocalMeters(localX, localY, ref);
  // Radius from RMS of range residuals, but floored by a fraction of the mean estimated range so
  // the circle stays honest: the RMS captures only geometric fit, not the dominant RSSI->distance
  // model error (multiplicative 2-5x at 915 MHz). Three mutually-consistent-but-wrong ranges would
  // otherwise yield a tiny RMS and a falsely precise circle. Floor at ~35% of the mean range.
  const rms = Math.sqrt(
    pts.reduce((s, P) => s + (Math.hypot(P.x - localX, P.y - localY) - P.r) ** 2, 0) / pts.length,
  );
  const meanRangeM = pts.reduce((s, P) => s + P.r, 0) / pts.length;
  const radiusM = Math.min(60_000, Math.max(MIN_RADIUS_M, rms, meanRangeM * 0.35) * widen);
  return { lat: est.lat, lon: est.lon, radiusM, tier: 3, receiverCount, possiblyMobile };
}
