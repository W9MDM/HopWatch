// Predicted RF coverage: a max-range ring per node from a simple link budget + radio
// horizon. Pure and testable. Meshtastic MQTT does not broadcast TX power or antenna
// height, so the inputs come from a per-node RF profile (operator-set) that defaults from
// the node's GPS altitude and config defaults.

export interface CoverageParams {
  defaultEirpDbm: number; // assumed EIRP when a node has no override
  defaultHeightM: number; // fallback antenna height when there is no override or altitude
  rxHeightM: number; // assumed receiver antenna height (handheld ~2 m)
  rxSensitivityDbm: number; // LoRa receiver sensitivity floor (e.g. -128)
  pathLossExponent: number; // log-distance exponent n
  referenceLossDb1km: number; // path loss at 1 km
  maxRadiusKm: number; // clamp so absurd values never draw
}

export interface NodeRf {
  eirpDbm?: number | null; // per-node override
  heightM?: number | null; // per-node antenna-height override (metres AGL)
  altitudeM?: number | null; // GPS altitude (metres above MSL). NOT a height, see below.
}

/**
 * Effective antenna height above local ground, in metres: the per-node override, else the
 * configured default.
 *
 * GPS altitude is deliberately NOT used. Meshtastic's Position.altitude is documented in mesh.proto
 * as "in meters above MSL", i.e. an elevation, not a height above the ground under the antenna, and
 * the radio horizon term below wants the latter. Using it made terrain elevation masquerade as
 * antenna height: a handheld on the ground in Denver reports 1600 m, giving a 170 km horizon, which
 * stops limiting anything, so the ring becomes the link-budget range and then clamps to
 * coverage.max_radius_km; the identical radio at sea level draws 17.5 km. Elevation genuinely does
 * extend a horizon, but only relative to the surrounding terrain, which needs a DEM: until then the
 * honest default is the configured height, with rf_height_m as the per-node truth.
 */
export function effectiveHeightM(n: NodeRf, p: CoverageParams): number {
  return Math.max(1, n.heightM ?? p.defaultHeightM);
}

export function effectiveEirpDbm(n: NodeRf, p: CoverageParams): number {
  return n.eirpDbm ?? p.defaultEirpDbm;
}

/**
 * Predicted coverage radius (km): the lesser of the radio horizon (set by antenna height,
 * so tall towers reach far) and the link-budget range (EIRP down to receiver sensitivity via
 * the log-distance model). Clamped to maxRadiusKm.
 */
export function coverageRadiusKm(n: NodeRf, p: CoverageParams): number {
  const h = effectiveHeightM(n, p);
  const eirp = effectiveEirpDbm(n, p);
  const horizonKm = 4.12 * (Math.sqrt(h) + Math.sqrt(Math.max(1, p.rxHeightM))); // 4/3-earth radio horizon
  const maxPathLoss = eirp - p.rxSensitivityDbm;
  const rfKm = Math.pow(10, (maxPathLoss - p.referenceLossDb1km) / (10 * p.pathLossExponent));
  return Math.min(p.maxRadiusKm, Math.max(0.1, Math.min(horizonKm, rfKm)));
}

// ---------------------------------------------------------------------------
// Site planner: predict what a hypothetical new node at a candidate location would
// cover, using the same log-distance model as the coverage ring. Pure and testable.
// ---------------------------------------------------------------------------

/** Predicted receive RSSI (dBm) at a distance, from the same log-distance path-loss model. */
export function predictedRssiDbm(distanceKm: number, eirpDbm: number, p: CoverageParams): number {
  const d = Math.max(0.01, distanceKm);
  const pathLoss = p.referenceLossDb1km + 10 * p.pathLossExponent * Math.log10(d);
  return eirpDbm - pathLoss;
}

export interface PlannerNode {
  node_id: number;
  latitude: number;
  longitude: number;
  direct_gateways: number; // how many gateways currently hear this node direct
}

export interface SitePrediction {
  node_id: number;
  distance_km: number;
  predicted_rssi: number;
  in_range: boolean;
  newly_covered: boolean; // in range AND currently a coverage gap/single-point (<=1 direct gw)
}

export interface SitePlan {
  radius_km: number;
  in_range: number;
  newly_covered: number;
  predictions: SitePrediction[]; // nearest first
}

/**
 * Predict coverage of a candidate node. Import { haversineKm } is passed in to keep this
 * module dependency-free and unit-testable in isolation.
 */
export function planSite(
  candidate: { lat: number; lon: number; eirpDbm: number; heightM: number },
  nodes: PlannerNode[],
  p: CoverageParams,
  distanceKm: (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => number,
): SitePlan {
  const radiusKm = coverageRadiusKm({ eirpDbm: candidate.eirpDbm, heightM: candidate.heightM }, p);
  const predictions: SitePrediction[] = nodes.map((n) => {
    const dist = distanceKm({ lat: candidate.lat, lon: candidate.lon }, { lat: n.latitude, lon: n.longitude });
    const inRange = dist <= radiusKm;
    return {
      node_id: n.node_id,
      distance_km: dist,
      predicted_rssi: predictedRssiDbm(dist, candidate.eirpDbm, p),
      in_range: inRange,
      newly_covered: inRange && n.direct_gateways <= 1,
    };
  });
  predictions.sort((a, b) => a.distance_km - b.distance_km);
  return {
    radius_km: radiusKm,
    in_range: predictions.filter((x) => x.in_range).length,
    newly_covered: predictions.filter((x) => x.newly_covered).length,
    predictions,
  };
}
