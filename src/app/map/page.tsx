import { moduleDenied } from "../../components/ModuleGate.tsx";
import { getMapData, getEstimatedMapNodes, distinctBrokers, type MapFilter } from "../../db/queries.ts";
import { distinctChannels } from "../../db/settings.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { DbError } from "../../components/DbError.tsx";
import { MeshMap } from "../../components/MeshMap.tsx";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../auth/session.ts";
import { pageAccess } from "../../auth/rbac.ts";
import { currentUserPrefs, resolveDefault } from "../../auth/prefs.ts";
import { fuzzPositions, fuzzDecimalsFor } from "../../lib/fuzz.ts";
import { MapIntroBanner } from "../../components/MapIntroBanner.tsx";
import { mapTiles } from "../../lib/maptiles.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Map" };

type SP = Record<string, string | string[] | undefined>;

export default async function MapPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("map"); if (__denied) return __denied;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  // Seed the filter from the user's saved defaults when the URL has no explicit choice; an
  // explicit "all" in the URL overrides the default (see resolveDefault).
  const prefs = await currentUserPrefs();
  const filter: MapFilter = {
    broker: resolveDefault(one("broker"), prefs.default_broker),
    channelId: resolveDefault(one("channel"), prefs.default_channel),
  };

  let real, estimated, brokers: string[], channels: string[], maxAgeMin = 0;
  let center: { lat: number; lon: number; zoom: number } | null = null;
  try {
    // Position-estimation settings are DB-backed (admin UI) and hot-reload via effectiveConfig().
    const cfg = await effectiveConfig();
    const estimationOn = cfg.position_estimation.enabled;
    maxAgeMin = cfg.server.ui.map_max_age.map;
    const mc = cfg.server.ui.map_center;
    if (mc.lat != null && mc.lon != null) center = { lat: mc.lat, lon: mc.lon, zoom: mc.zoom };
    [real, estimated, brokers, channels] = await Promise.all([
      getMapData(filter),
      estimationOn ? getEstimatedMapNodes(filter) : Promise.resolve([]),
      distinctBrokers(),
      distinctChannels(),
    ]);
  } catch (e) {
    return <DbError error={e} />;
  }

  // Claim controls appear in popups only for signed-in users who can reach owned nodes.
  // Admin status also decides whether positions are fuzzed for this viewer.
  let canClaim = false, isAdmin = false;
  try {
    const jar = await cookies();
    if (verifySession(jar.get(SESSION_COOKIE)?.value)) {
      const access = await pageAccess();
      isAdmin = access.admin;
      canClaim = access.admin || access.modules.has("owned");
    }
  } catch { /* claim button simply hidden if access cannot be resolved */ }

  // Location privacy: round coordinates for non-admins when enabled (opt-in).
  let fuzz: number | null = null;
  try { fuzz = fuzzDecimalsFor(await effectiveConfig(), isAdmin); } catch { /* exact if config unreadable */ }
  const nodes = fuzzPositions([...real.nodes, ...estimated], fuzz);

  return (
    <div className="space-y-4">
      <MapIntroBanner />
      <div className="flex items-center justify-between">
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Map
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-faint">
          <span>{real.nodes.length} positioned</span>
          {estimated.length > 0 && <span>· {estimated.length} estimated</span>}
          {/* Accessible alternative to the canvas map: a fully keyboard/screen-reader
              navigable node roster (a11y audit). */}
          <a href="/nodes" className="rounded-md border border-line px-2 py-0.5 hover:bg-raised hover:text-ink">View as list</a>
        </div>
      </div>
      {nodes.length === 0 ? (
        <div className="card text-ink-faint">No node positions received yet.</div>
      ) : (
        <MeshMap nodes={nodes} links={real.links} tile={await mapTiles()} brokers={brokers} channels={channels} filter={filter} canClaim={canClaim} defaultMaxAgeMin={maxAgeMin} defaultCenter={center} />
      )}
    </div>
  );
}
