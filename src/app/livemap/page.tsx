import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { effectiveConfig } from "../../db/appsettings.ts";
import { LiveMap, type LiveMapConfig } from "../../components/LiveMap.tsx";
import { currentUserPrefs } from "../../auth/prefs.ts";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../auth/session.ts";
import { pageAccess } from "../../auth/rbac.ts";
import type { MapTiles } from "../../lib/maptiles.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Live map" };

async function settings(): Promise<{ enabled: boolean; cfg: LiveMapConfig; tile: MapTiles; maxAgeMin: number; center: { lat: number; lon: number; zoom: number } | null }> {
  const fallbackTile: MapTiles = { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap contributors", darkUrl: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", darkAttribution: "© OpenStreetMap © CARTO" };
  try {
    const c = await effectiveConfig();
    const lm = c.livemap as {
      enabled?: boolean; gateway_rings_default?: boolean; audio_default?: boolean; max_animations_per_sec?: number; trail_decay_seconds?: number;
    };
    return {
      enabled: lm.enabled !== false,
      cfg: {
        gatewayRings: lm.gateway_rings_default !== false,
        audioDefault: !!lm.audio_default,
        maxAnimationsPerSec: Number(lm.max_animations_per_sec ?? 50),
        trailDecaySeconds: Number(lm.trail_decay_seconds ?? 30),
      },
      tile: {
        url: c.server.ui.tile_provider.url_template, attribution: c.server.ui.tile_provider.attribution,
        darkUrl: c.server.ui.tile_provider_dark.url_template, darkAttribution: c.server.ui.tile_provider_dark.attribution,
      },
      maxAgeMin: c.server.ui.map_max_age.livemap,
      center: c.server.ui.map_center.lat != null && c.server.ui.map_center.lon != null
        ? { lat: c.server.ui.map_center.lat, lon: c.server.ui.map_center.lon, zoom: c.server.ui.map_center.zoom }
        : null,
    };
  } catch {
    return { enabled: true, cfg: { gatewayRings: true, audioDefault: false, maxAnimationsPerSec: 50, trailDecaySeconds: 30 }, tile: fallbackTile, maxAgeMin: 0, center: null };
  }
}

type SP = Record<string, string | string[] | undefined>;

export default async function LiveMapPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("livemap"); if (__denied) return __denied;
  const sp = await searchParams;
  const routeRaw = Array.isArray(sp.route) ? sp.route[0] : sp.route;
  const replayRoute = routeRaw
    ? routeRaw.split(",").map((x) => Number(x)).filter((n) => Number.isFinite(n))
    : undefined;

  const { enabled, cfg, tile, maxAgeMin, center } = await settings();
  if (!enabled) {
    return <div className="card text-ink-mute">The live map is disabled (set <span className="mono">livemap.enabled: true</span>).</div>;
  }
  const prefs = await currentUserPrefs();
  let canClaim = false;
  try {
    const jar = await cookies();
    if (verifySession(jar.get(SESSION_COOKIE)?.value)) {
      const access = await pageAccess();
      canClaim = access.admin || access.modules.has("owned");
    }
  } catch { /* claim button hidden if access cannot be resolved */ }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="eyebrow">
            <span className="eyebrow-bar" />
            Live map
          </h1>
          <p className="mt-1 text-[13px] text-ink-faint">Real-time packet receptions. Observed paths only; inferred topology is dashed.</p>
        </div>
        <Link className="btn btn-outline h-8 px-3 text-[13px]" href="/graph">Graph view</Link>
      </div>
      <LiveMap cfg={cfg} tile={tile} replayRoute={replayRoute} defaultBroker={prefs.default_broker} defaultChannel={prefs.default_channel} canClaim={canClaim} defaultMaxAgeMin={maxAgeMin} defaultCenter={center} />
    </div>
  );
}
