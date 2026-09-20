import { haversineKm } from "./geo.ts";

/**
 * First Fresnel-zone radius in metres at a point along the path.
 *
 * r = 17.32 * sqrt(d1 * d2 / (f * D))   with d1/d2/D in km, f in GHz, r in m.
 *
 * The 17.32 constant is the standard form; its midpoint simplification (d1 = d2 = D/2) is
 * 8.66 * sqrt(D / f), which is where the halved 8.657 constant crept in: it was applied to the
 * GENERAL formula as well, and additionally divided by 2 for the midpoint case. Both produced a
 * zone exactly half its true height, so terrain that genuinely intrudes into the first Fresnel
 * zone was reported as clear and obstruction detection was systematically optimistic.
 */
export function fresnelRadiusM(d1Km: number, d2Km: number, totalKm: number, fGHz: number): number {
  if (totalKm <= 0 || fGHz <= 0) return 0;
  return 17.32 * Math.sqrt(Math.max(0, d1Km * d2Km) / (totalKm * fGHz));
}

/** Widest point of the first Fresnel zone (its midpoint), in metres. */
export function fresnelMaxM(totalKm: number, fGHz: number): number {
  return fresnelRadiusM(totalKm / 2, totalKm / 2, totalKm, fGHz);
}


// On-demand line-of-sight / terrain profile between two points (Malla-style), computed live
// rather than from stored link budgets so any node pair can be checked. Samples an open
// elevation dataset along the great circle, draws the antenna-to-antenna LOS line and the
// bottom of the first Fresnel zone, and reports the worst clearance (negative = obstructed).

export interface LosSample { d_km: number; ground_m: number; los_m: number; fresnel_bottom_m: number }
export interface LosResult {
  distance_km: number;
  fspl_db: number;          // free-space path loss at this distance/frequency
  fresnel_max_m: number;    // first Fresnel radius at midpoint
  has_terrain: boolean;     // whether an elevation profile was obtained
  clearance_m: number | null; // worst Fresnel-bottom-minus-ground along the path (null if no terrain)
  obstructed: boolean;      // terrain rises into the first Fresnel zone
  a_ground_m: number | null;
  b_ground_m: number | null;
  samples: LosSample[];
}

interface Endpoint { lat: number; lon: number; antennaM: number }

export async function computeLos(
  a: Endpoint,
  b: Endpoint,
  opts: { freqMhz?: number; elevationUrl?: string; samples?: number } = {},
): Promise<LosResult> {
  const freqMhz = opts.freqMhz && opts.freqMhz > 0 ? opts.freqMhz : 915;
  const fGHz = freqMhz / 1000;
  const distanceKm = haversineKm({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon });
  const d = Math.max(distanceKm, 0.001);
  const fspl = 32.44 + 20 * Math.log10(d) + 20 * Math.log10(freqMhz);
  const fresnelMax = fresnelMaxM(d, fGHz);

  const base: LosResult = {
    distance_km: distanceKm, fspl_db: fspl, fresnel_max_m: fresnelMax,
    has_terrain: false, clearance_m: null, obstructed: false, a_ground_m: null, b_ground_m: null, samples: [],
  };
  if (!opts.elevationUrl) return base;

  const N = Math.min(64, Math.max(8, opts.samples ?? 40));
  const locations = Array.from({ length: N + 1 }, (_, i) => {
    const f = i / N;
    return { latitude: a.lat + (b.lat - a.lat) * f, longitude: a.lon + (b.lon - a.lon) * f };
  });
  let elev: number[];
  try {
    const res = await fetch(opts.elevationUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locations }),
    });
    if (!res.ok) return base;
    const j: any = await res.json();
    elev = (j?.results ?? []).map((r: any) => Number(r.elevation));
    if (elev.length !== N + 1 || elev.some((e) => !Number.isFinite(e))) return base;
  } catch {
    return base;
  }

  const g0 = elev[0]! + a.antennaM;
  const gN = elev[N]! + b.antennaM;
  const samples: LosSample[] = [];
  let clearance = Infinity;
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const dKm = d * f;
    const los = g0 + (gN - g0) * f;
    const r = fresnelRadiusM(dKm, d - dKm, d, fGHz);
    const bottom = los - r;
    samples.push({ d_km: dKm, ground_m: elev[i]!, los_m: los, fresnel_bottom_m: bottom });
    if (i > 0 && i < N) clearance = Math.min(clearance, bottom - elev[i]!);
  }
  const clear = Number.isFinite(clearance) ? clearance : null;
  return { ...base, has_terrain: true, clearance_m: clear, obstructed: clear !== null && clear < 0, a_ground_m: elev[0]!, b_ground_m: elev[N]!, samples };
}
