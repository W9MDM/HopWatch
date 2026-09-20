// Pure geodesic helpers. No DB, no globals: safe to unit test and to import from both
// the worker (position estimation) and the web (confidence circles on the map).

export interface LatLon {
  lat: number;
  lon: number;
}

const R_KM = 6371;
const R_M = 6_371_000;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Point at a bearing (degrees clockwise from north) and distance (km) from origin. */
export function destinationPoint(origin: LatLon, bearingDeg: number, distKm: number): LatLon {
  const d = distKm / R_KM;
  const brng = bearingDeg * D2R;
  const lat1 = origin.lat * D2R;
  const lon1 = origin.lon * D2R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lon2 =
    lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * R2D, lon: lon2 * R2D };
}

/**
 * GeoJSON polygon ring (array of [lon, lat]) approximating a geodesic circle. Closed
 * (first point repeated). Used for the translucent confidence circle on the map.
 */
export function circlePolygon(center: LatLon, radiusM: number, steps = 48): number[][] {
  const ring: number[][] = [];
  const km = Math.max(0, radiusM) / 1000;
  for (let i = 0; i <= steps; i++) {
    const p = destinationPoint(center, (360 * i) / steps, km);
    ring.push([p.lon, p.lat]);
  }
  return ring;
}

/** Equirectangular projection to local metres around a reference point. */
/**
 * Normalize a longitude (or a longitude DIFFERENCE) into [-180, 180].
 *
 * Longitude is circular, so plain arithmetic on it breaks at the antimeridian. Two gateways in Fiji
 * at 179.9 and -179.9 are ~20 km apart, but `179.9 - -179.9` is 359.8 degrees: unwrapped, the local
 * frame put them 4e7 m apart and the multilateration solve returned a point in the wrong hemisphere,
 * with the radius clamped to its ceiling so the map drew a confident 60 km circle.
 */
export function wrapLon(deg: number): number {
  const x = ((deg + 180) % 360 + 360) % 360;
  return x - 180;
}

/**
 * Weighted CIRCULAR mean of longitudes, in degrees. A plain arithmetic mean of 179.9 and -179.9 is
 * 0, i.e. the Gulf of Guinea, about 20000 km from either input.
 */
export function meanLon(lons: number[], weights?: number[]): number {
  let sx = 0, sy = 0;
  for (let i = 0; i < lons.length; i++) {
    const w = weights?.[i] ?? 1;
    sx += w * Math.cos(lons[i]! * D2R);
    sy += w * Math.sin(lons[i]! * D2R);
  }
  // Antipodal inputs cancel exactly and leave no defined mean; fall back to the first value rather
  // than atan2(0, 0) = 0, which would silently claim the prime meridian.
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) return lons[0] ?? 0;
  return Math.atan2(sy, sx) * R2D;
}

export function toLocalMeters(p: LatLon, ref: LatLon): { x: number; y: number } {
  const x = wrapLon(p.lon - ref.lon) * D2R * Math.cos(ref.lat * D2R) * R_M;
  const y = (p.lat - ref.lat) * D2R * R_M;
  return { x, y };
}

/** Inverse of toLocalMeters. */
export function fromLocalMeters(x: number, y: number, ref: LatLon): LatLon {
  const lat = ref.lat + (y / R_M) * R2D;
  const lon = wrapLon(ref.lon + (x / (R_M * Math.cos(ref.lat * D2R))) * R2D);
  return { lat, lon };
}
