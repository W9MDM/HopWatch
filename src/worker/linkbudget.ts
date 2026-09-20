import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { fresnelRadiusM, fresnelMaxM } from "../lib/los.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// Link budget validator. For direct-link pairs with known positions, compute the
// free-space path loss, the first Fresnel-zone radius, and the gap between expected
// and observed RSSI. Terrain clearance is added when an elevation source is enabled;
// otherwise the free-space figures are stored (spec: RF/propagation).
const FREQ_MHZ = 915; // US Meshtastic default; adjust per-region later
const ASSUMED_EIRP_DBM = 30; // rough transmit EIRP used for the expected-RSSI baseline

interface Pair {
  gateway_id: number;
  node_id: number;
  distance_km: number;
  observed_rssi: number | null;
  ga_lat: number; ga_lon: number; nb_lat: number; nb_lon: number;
}

export async function computeLinkBudgets(cfg: HopWatchConfig): Promise<number> {
  const lb = (cfg.rf as any)?.link_budget ?? {};
  if (!lb.enabled) return 0;
  const maxKm = Number(lb.max_distance_km ?? 60);

  const pairs = await query<Pair>(
    `SELECT l.gateway_id, l.node_id, l.last_direct_rssi AS observed_rssi,
            gp.latitude AS ga_lat, gp.longitude AS ga_lon, np.latitude AS nb_lat, np.longitude AS nb_lon,
            6371*ACOS(LEAST(1, COS(RADIANS(gp.latitude))*COS(RADIANS(np.latitude))*
              COS(RADIANS(np.longitude)-RADIANS(gp.longitude))+SIN(RADIANS(gp.latitude))*SIN(RADIANS(np.latitude)))) AS distance_km
     FROM gateway_node_link l
     JOIN node_positions gp ON gp.node_id=l.gateway_id
     JOIN node_positions np ON np.node_id=l.node_id
     WHERE l.direct_count>0 AND l.gateway_id<>l.node_id
       AND gp.latitude IS NOT NULL AND np.latitude IS NOT NULL
     HAVING distance_km BETWEEN 0.05 AND ?`,
    [maxKm],
  );

  const terrainOn = Boolean(lb.terrain);
  const antenna = Number(lb.antenna_height_m ?? 3);
  const elevationUrl = String(lb.elevation_url ?? "https://api.open-elevation.com/api/v1/lookup");

  let n = 0;
  for (const p of pairs) {
    const d = Number(p.distance_km);
    const fspl = 32.44 + 20 * Math.log10(d) + 20 * Math.log10(FREQ_MHZ); // dB, d in km, f in MHz
    const fresnelMax = fresnelMaxM(d, FREQ_MHZ / 1000); // metres, widest point of the first zone
    const expectedRssi = ASSUMED_EIRP_DBM - fspl;
    const deficit = p.observed_rssi != null ? expectedRssi - p.observed_rssi : null;

    // fresnel_max_m (the zone's widest radius) is a property of distance and frequency alone, so
    // it is always meaningful and belongs in the profile.
    const profile: Record<string, unknown> = {
      freq_mhz: FREQ_MHZ, eirp_dbm: ASSUMED_EIRP_DBM, expected_rssi: expectedRssi, fresnel_max_m: fresnelMax,
    };
    // Clearance is how much room terrain leaves below the zone, which is only knowable from a
    // terrain profile. This used to default to fresnelMax (the zone RADIUS) when terrain was off,
    // i.e. the default: a completely different quantity stored in a column named
    // fresnel_clearance and rendered as "Fresnel clearance", so every unmeasured path advertised a
    // large positive clearance and looked healthy regardless of the actual terrain. Unmeasured is
    // now NULL, which the UI already renders as "-".
    let fresnelClearance: number | null = null;
    if (terrainOn) {
      const terr = await sampleTerrain(p, d, antenna, elevationUrl).catch(() => null);
      if (terr) {
        profile.samples = terr.samples;
        fresnelClearance = terr.clearance_m;
      }
    }

    await query(
      `INSERT INTO terrain_link_budget
         (node_a, node_b, computed_at, distance_km, expected_path_loss_db, fresnel_clearance, observed_rssi, deficit_db, profile)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE computed_at=VALUES(computed_at), distance_km=VALUES(distance_km),
         expected_path_loss_db=VALUES(expected_path_loss_db), fresnel_clearance=VALUES(fresnel_clearance),
         observed_rssi=VALUES(observed_rssi), deficit_db=VALUES(deficit_db), profile=VALUES(profile)`,
      [p.gateway_id, p.node_id, toMysqlUtc(new Date()), d, fspl, fresnelClearance, p.observed_rssi, deficit, JSON.stringify(profile)],
    );
    n++;
  }
  return n;
}

interface Sample { d_km: number; ground_m: number; los_m: number; fresnel_bottom_m: number }

// Sample the terrain profile along the path from an open elevation dataset and compute
// first-Fresnel-zone clearance. Best-effort: returns null if the elevation source fails.
async function sampleTerrain(
  p: { ga_lat: number; ga_lon: number; nb_lat: number; nb_lon: number },
  distanceKm: number,
  antennaM: number,
  url: string,
): Promise<{ samples: Sample[]; clearance_m: number } | null> {
  const N = 24;
  const locations = Array.from({ length: N + 1 }, (_, i) => {
    const f = i / N;
    return { latitude: p.ga_lat + (p.nb_lat - p.ga_lat) * f, longitude: p.ga_lon + (p.nb_lon - p.ga_lon) * f };
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locations }),
  });
  if (!res.ok) return null;
  const j: any = await res.json();
  const elev: number[] = (j?.results ?? []).map((r: any) => Number(r.elevation));
  if (elev.length !== N + 1) return null;

  const g0 = elev[0]! + antennaM;
  const gN = elev[N]! + antennaM;
  const fGHz = FREQ_MHZ / 1000;
  const samples: Sample[] = [];
  let clearance = Infinity;
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const dKm = distanceKm * f;
    const los = g0 + (gN - g0) * f; // straight line between antenna tops
    const d1 = dKm;
    const d2 = distanceKm - dKm;
    const r = fresnelRadiusM(d1, d2, distanceKm, fGHz);
    const bottom = los - r;
    const ground = elev[i]!;
    samples.push({ d_km: dKm, ground_m: ground, los_m: los, fresnel_bottom_m: bottom });
    if (i > 0 && i < N) clearance = Math.min(clearance, bottom - ground); // negative = obstructed
  }
  return { samples, clearance_m: Number.isFinite(clearance) ? clearance : 0 };
}
