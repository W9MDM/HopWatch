import { moduleDenied } from "../../components/ModuleGate.tsx";
import { getCoverage, getEstimatedNodes, distinctBrokers, type MapFilter } from "../../db/queries.ts";
import { distinctChannels } from "../../db/settings.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { DbError } from "../../components/DbError.tsx";
import { CoverageMap, type CoverageEstimate } from "../../components/CoverageMap.tsx";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../auth/session.ts";
import { pageAccess } from "../../auth/rbac.ts";
import { fuzzPositions, fuzzDecimalsFor } from "../../lib/fuzz.ts";
import { mapTiles } from "../../lib/maptiles.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Coverage" };

type SP = Record<string, string | string[] | undefined>;

export default async function CoveragePage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("coverage"); if (__denied) return __denied;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const filter: MapFilter = { broker: one("broker") || undefined, channelId: one("channel") || undefined };

  let nodes, estimates: CoverageEstimate[], brokers: string[], channels: string[];
  let coverageParams;
  let center: { lat: number; lon: number; zoom: number } | null = null;
  try {
    // Estimates only feed the coverage view behind an explicit flag (DB-backed, admin UI):
    // feeding inferred positions into coverage math compounds error, so it is off by default.
    const cfg = await effectiveConfig();
    const feedEstimates = cfg.position_estimation.feed_coverage_heatmap;
    const mc = cfg.server.ui.map_center;
    if (mc.lat != null && mc.lon != null) center = { lat: mc.lat, lon: mc.lon, zoom: mc.zoom };
    const c = cfg.coverage;
    coverageParams = {
      defaultEirpDbm: c.default_eirp_dbm, defaultHeightM: c.default_height_m, rxHeightM: c.rx_height_m,
      rxSensitivityDbm: c.rx_sensitivity_dbm, pathLossExponent: c.path_loss_exponent,
      referenceLossDb1km: c.reference_loss_db_1km, maxRadiusKm: c.max_radius_km,
    };
    [nodes, estimates, brokers, channels] = await Promise.all([
      getCoverage(filter),
      feedEstimates ? (getEstimatedNodes() as Promise<CoverageEstimate[]>) : Promise.resolve([]),
      distinctBrokers(),
      distinctChannels(),
    ]);
  } catch (e) {
    return <DbError error={e} />;
  }

  let canClaim = false, isAdmin = false;
  try {
    const jar = await cookies();
    if (verifySession(jar.get(SESSION_COOKIE)?.value)) {
      const access = await pageAccess();
      isAdmin = access.admin;
      canClaim = access.admin || access.modules.has("owned");
    }
  } catch { /* claim button hidden if access cannot be resolved */ }

  // Location privacy: round coordinates for non-admins when enabled (opt-in).
  let fuzz: number | null = null;
  try { fuzz = fuzzDecimalsFor(await effectiveConfig(), isAdmin); } catch { /* exact if config unreadable */ }
  nodes = fuzzPositions(nodes, fuzz);
  estimates = fuzzPositions(estimates, fuzz);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Coverage heatmap
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          Nodes colored by how many gateways hear them direct; larger dots have stronger RSSI.
          {estimates.length > 0 ? " Estimated (non-GPS) positions are shown per config." : ""}
        </p>
      </div>
      {nodes.length === 0 && estimates.length === 0 ? (
        <div className="card text-ink-faint">No node positions yet.</div>
      ) : (
        <CoverageMap nodes={nodes} tile={await mapTiles()} brokers={brokers} channels={channels} filter={filter} estimates={estimates} coverageParams={coverageParams} canClaim={canClaim} defaultCenter={center} />
      )}
    </div>
  );
}
