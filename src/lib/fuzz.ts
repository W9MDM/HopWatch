// Location privacy: round self-reported node coordinates to a coarser grid so a public map
// cannot pin a hobbyist's home to the meter. Applied to map/coverage/livemap output for
// non-admins when server.privacy.fuzz_positions is on; admins see the true fix. Rounding (not
// random jitter) is deterministic, so a node does not appear to wander between renders.
//
// decimals -> approximate worst-case grid at mid-latitudes: 2 ~= 1.1 km, 3 ~= 110 m, 4 ~= 11 m.

function round(v: number | null | undefined, decimals: number): number | null {
  if (v == null || !Number.isFinite(v)) return v ?? null;
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/**
 * Return a copy of the node list with latitude/longitude rounded to `decimals` places.
 * Pass decimals=null to leave positions untouched (fuzzing off, or the viewer is an admin).
 * Works on any row shape carrying numeric `latitude`/`longitude`.
 */
export function fuzzPositions<T extends { latitude?: number | null; longitude?: number | null }>(
  rows: T[],
  decimals: number | null,
): T[] {
  if (decimals == null) return rows;
  return rows.map((r) => ({ ...r, latitude: round(r.latitude, decimals), longitude: round(r.longitude, decimals) }));
}

/** The decimals to fuzz to for this request, or null when positions should stay exact. */
export function fuzzDecimalsFor(
  cfg: { server: { privacy: { fuzz_positions: boolean; fuzz_decimals: number } } },
  isAdmin: boolean,
): number | null {
  if (isAdmin || !cfg.server.privacy.fuzz_positions) return null;
  return cfg.server.privacy.fuzz_decimals;
}

/** Round one coordinate. `decimals` null leaves it exact. */
export function roundCoord(v: number | null | undefined, decimals: number | null): number | null {
  return decimals == null ? (v ?? null) : round(v, decimals);
}

/** The position-bearing fields of a node-detail row. */
export interface NodeCoordFields {
  latitude?: number | null;
  longitude?: number | null;
  est_latitude?: number | null;
  est_longitude?: number | null;
  altitude_m?: number | null;
  precision_bits?: number | null;
  has_position?: number | boolean | null;
  position_source?: string | null;
  confidence_radius_m?: number | null;
}

/**
 * Round BOTH coordinate pairs a node-detail row carries. `fuzzPositions` only touches
 * latitude/longitude, so an estimate would otherwise stay exact and give the fuzzed GPS pair away.
 */
export function fuzzNodeCoords<T extends NodeCoordFields>(node: T, decimals: number | null): T {
  if (decimals == null) return node;
  return {
    ...node,
    latitude: round(node.latitude, decimals),
    longitude: round(node.longitude, decimals),
    est_latitude: round(node.est_latitude, decimals),
    est_longitude: round(node.est_longitude, decimals),
  };
}

/**
 * Blank every position field on a node whose position the operator suppressed
 * (`nodes.position_ignored`, the /admin per-node control). The map queries all filter these rows
 * out in SQL; the node-detail and replay surfaces did not, so a suppressed node still published its
 * exact fix and its movement track. Admins keep seeing it, since they set the flag.
 */
export function stripNodePosition<T extends NodeCoordFields>(node: T): T {
  return {
    ...node,
    latitude: null, longitude: null, altitude_m: null, precision_bits: null,
    est_latitude: null, est_longitude: null, confidence_radius_m: null,
    has_position: 0, position_source: null,
  };
}
