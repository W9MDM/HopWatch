import { moduleDenied } from "../../components/ModuleGate.tsx";
import { getCoverage } from "../../db/queries.ts";
import { pageAccess } from "../../auth/rbac.ts";
import { fuzzPositions, fuzzDecimalsFor } from "../../lib/fuzz.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { DbError } from "../../components/DbError.tsx";
import { SitePlanner, type PlannerMapNode } from "../../components/SitePlanner.tsx";
import { mapTiles } from "../../lib/maptiles.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SitePlannerPage() {
  const __denied = await moduleDenied("site-planner"); if (__denied) return __denied;

  let nodes: PlannerMapNode[];
  let coverageParams;
  try {
    const cfg = await effectiveConfig();
    const c = cfg.coverage;
    coverageParams = {
      defaultEirpDbm: c.default_eirp_dbm, defaultHeightM: c.default_height_m, rxHeightM: c.rx_height_m,
      rxSensitivityDbm: c.rx_sensitivity_dbm, pathLossExponent: c.path_loss_exponent,
      referenceLossDb1km: c.reference_loss_db_1km, maxRadiusKm: c.max_radius_km,
    };
    // The planner map plots real node positions, so it honours the same privacy policy as /map and
    // /coverage; without this it was a way to read exact coordinates the other maps blur.
    const fuzz = fuzzDecimalsFor(cfg, (await pageAccess()).admin);
    const cov = fuzzPositions(await getCoverage({}), fuzz);
    nodes = cov.map((n) => ({
      node_id: n.node_id,
      name: n.long_name ?? n.short_name ?? "",
      latitude: n.latitude,
      longitude: n.longitude,
      direct_gateways: n.direct_gateways,
    }));
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Site planner
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          Drop a candidate node to predict its coverage from the link-budget model, and see which
          existing nodes it would likely hear direct. Nodes it would newly cover (currently a gap or
          single-gateway point) are highlighted. Tune the defaults in <span className="mono">/admin/settings</span> (RF &amp; propagation, coverage model).
        </p>
      </div>
      {nodes.length === 0 ? (
        <div className="card text-ink-faint">No node positions yet.</div>
      ) : (
        <SitePlanner nodes={nodes} tile={await mapTiles()} coverageParams={coverageParams} />
      )}
    </div>
  );
}
