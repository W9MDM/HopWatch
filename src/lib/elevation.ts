import { query } from "../db/client.ts";
import { toMysqlUtc } from "./time.ts";

// Ground-elevation sampling with a persistent cache. Terrain never changes, so a sampled point
// is cached forever (migration 0065) and only genuine cache misses reach the upstream source.
// Points are snapped to a ~11 m grid so overlapping paths (many links share one gateway) reuse
// samples. USGS 3DEP is the default source: authoritative 1 m US data, no key, no quota, and a
// whole profile returns in one request. Open-Elevation stays available for a self-hosted or
// non-US endpoint. Derived data per CLAUDE.md Rule 8: cached here, never merged into an
// authoritative table.

export type ElevationSource = "usgs_3dep" | "open_elevation";
export interface ElevPoint { lat: number; lon: number }

const USGS_GETSAMPLES =
  "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples";
const OPEN_ELEVATION_DEFAULT = "https://api.open-elevation.com/api/v1/lookup";
const GRID = 10000; // 1e-4 deg, about 11 m
const MIN_M = -500; // plausible ground band; anything outside is treated as no-data
const MAX_M = 9000;
const FETCH_TIMEOUT_MS = 20_000;

export function normalizeSource(v: unknown): ElevationSource {
  return v === "open_elevation" ? "open_elevation" : "usgs_3dep";
}

const snap = (v: number) => Math.round(v * GRID);
const valid = (e: number) => Number.isFinite(e) && e > MIN_M && e < MAX_M;

// Parse a USGS 3DEP ImageServer getSamples response into elevations by input index. getSamples
// returns samples in arbitrary order, each carrying a locationId that indexes the input
// multipoint, so each value is re-seated by locationId. Missing or no-data points stay null.
export function parseUsgsSamples(json: unknown, n: number): (number | null)[] {
  const out: (number | null)[] = new Array(n).fill(null);
  const samples = (json as { samples?: unknown })?.samples;
  if (!Array.isArray(samples)) return out;
  for (const s of samples) {
    const idx = Number((s as { locationId?: unknown })?.locationId);
    const v = Number((s as { value?: unknown })?.value);
    if (Number.isInteger(idx) && idx >= 0 && idx < n && valid(v)) out[idx] = v;
  }
  return out;
}

// Parse an open-elevation lookup response. Its results are returned in request order.
export function parseOpenElevation(json: unknown, n: number): (number | null)[] {
  const out: (number | null)[] = new Array(n).fill(null);
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) return out;
  for (let i = 0; i < Math.min(n, results.length); i++) {
    const v = Number((results[i] as { elevation?: unknown })?.elevation);
    out[i] = valid(v) ? v : null;
  }
  return out;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Fetch elevations for a set of (already unique, grid-snapped) points from the source, in order.
async function fetchFromSource(
  pts: { lat: number; lon: number }[],
  source: ElevationSource,
  url: string | undefined,
): Promise<(number | null)[]> {
  if (pts.length === 0) return [];
  if (source === "open_elevation") {
    const body = JSON.stringify({ locations: pts.map((p) => ({ latitude: p.lat, longitude: p.lon })) });
    const j = await fetchJson(url || OPEN_ELEVATION_DEFAULT, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    return j ? parseOpenElevation(j, pts.length) : new Array(pts.length).fill(null);
  }
  // usgs_3dep: one getSamples request, multipoint geometry in [lon, lat] order.
  const geometry = JSON.stringify({ points: pts.map((p) => [p.lon, p.lat]), spatialReference: { wkid: 4326 } });
  const form = new URLSearchParams({
    geometry, geometryType: "esriGeometryMultipoint", returnFirstValueOnly: "true", f: "json",
  });
  const j = await fetchJson(USGS_GETSAMPLES, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
  });
  return j ? parseUsgsSamples(j, pts.length) : new Array(pts.length).fill(null);
}

// Return ground elevations (metres) for points in input order. A point with no known elevation
// (source failure or no-data) comes back as null; the caller decides whether a partial profile
// is usable. Successful samples are cached; failures are not, so transient errors retry later.
export async function fetchElevations(
  points: ElevPoint[],
  opts: { source?: ElevationSource; url?: string } = {},
): Promise<(number | null)[]> {
  if (points.length === 0) return [];
  const source = normalizeSource(opts.source);

  const cellKey = (lat_e4: number, lon_e4: number) => `${lat_e4}:${lon_e4}`;
  const cells = new Map<string, { lat_e4: number; lon_e4: number }>();
  const pointKeys = points.map((p) => {
    const lat_e4 = snap(p.lat), lon_e4 = snap(p.lon);
    const k = cellKey(lat_e4, lon_e4);
    if (!cells.has(k)) cells.set(k, { lat_e4, lon_e4 });
    return k;
  });

  const resolved = new Map<string, number>();
  const cellList = [...cells.values()];

  // 1) Cache lookup over the unique grid cells.
  if (cellList.length > 0) {
    const inClause = cellList.map(() => "(?,?)").join(",");
    const params: (string | number)[] = [source];
    for (const c of cellList) params.push(c.lat_e4, c.lon_e4);
    const rows = await query<{ lat_e4: number; lon_e4: number; elevation_m: number }>(
      `SELECT lat_e4, lon_e4, elevation_m FROM elevation_cache
       WHERE source=? AND (lat_e4,lon_e4) IN (${inClause})`,
      params,
    );
    for (const r of rows) resolved.set(cellKey(r.lat_e4, r.lon_e4), Number(r.elevation_m));
  }

  // 2) Fetch the misses from the source, then cache the successes.
  const misses = cellList.filter((c) => !resolved.has(cellKey(c.lat_e4, c.lon_e4)));
  if (misses.length > 0) {
    const reqPts = misses.map((c) => ({ lat: c.lat_e4 / GRID, lon: c.lon_e4 / GRID }));
    const got = await fetchFromSource(reqPts, source, opts.url);
    const insertVals: (string | number)[] = [];
    const now = toMysqlUtc(new Date());
    for (let i = 0; i < misses.length; i++) {
      const e = got[i];
      if (e == null) continue;
      resolved.set(cellKey(misses[i]!.lat_e4, misses[i]!.lon_e4), e);
      insertVals.push(source, misses[i]!.lat_e4, misses[i]!.lon_e4, e, now);
    }
    if (insertVals.length > 0) {
      const rowCount = insertVals.length / 5;
      const vals = Array.from({ length: rowCount }, () => "(?,?,?,?,?)").join(",");
      await query(
        `INSERT INTO elevation_cache (source, lat_e4, lon_e4, elevation_m, fetched_at)
         VALUES ${vals}
         ON DUPLICATE KEY UPDATE elevation_m=VALUES(elevation_m), fetched_at=VALUES(fetched_at)`,
        insertVals,
      );
    }
  }

  // 3) Map back to the original point order.
  return pointKeys.map((k) => (resolved.has(k) ? resolved.get(k)! : null));
}
