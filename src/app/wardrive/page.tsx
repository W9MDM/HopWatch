import { moduleDenied } from "../../components/ModuleGate.tsx";
import { getCoverageSamples, type CoverageSample } from "../../db/queries.ts";
import { distinctChannels } from "../../db/settings.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { DbError } from "../../components/DbError.tsx";
import { CoverageHeatMap } from "../../components/CoverageHeatMap.tsx";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../auth/session.ts";
import { pageAccess } from "../../auth/rbac.ts";
import { fuzzDecimalsFor } from "../../lib/fuzz.ts";
import { mapTiles } from "../../lib/maptiles.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Wardrive" };

type SP = Record<string, string | string[] | undefined>;

export default async function WardrivePage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("coverage"); if (__denied) return __denied;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const channelId = one("channel") || undefined;
  const days = one("days") ? Number(one("days")) : 90;
  const mode: "signal" | "reach" = one("mode") === "reach" ? "reach" : "signal";

  // Location privacy: bin the coverage grid to the viewer's fuzz decimals (admins get the full 4).
  let isAdmin = false;
  try {
    const jar = await cookies();
    if (verifySession(jar.get(SESSION_COOKIE)?.value)) isAdmin = (await pageAccess()).admin;
  } catch { /* treated as non-admin for privacy */ }

  let samples: CoverageSample[], channels: string[];
  let center: { lat: number; lon: number; zoom: number } | null = null;
  try {
    const cfg = await effectiveConfig();
    const mc = cfg.server.ui.map_center;
    if (mc.lat != null && mc.lon != null) center = { lat: mc.lat, lon: mc.lon, zoom: mc.zoom };
    const fuzz = fuzzDecimalsFor(cfg, isAdmin); // null (exact) for admins, else the configured decimals
    const decimals = fuzz == null ? 4 : Math.min(4, fuzz);
    [samples, channels] = await Promise.all([
      getCoverageSamples({ days, channelId, decimals, mode, excludeMobileGateways: cfg.wardrive.exclude_mobile_gateways }),
      distinctChannels(),
    ]);
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Wardrive coverage
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          Actual over-the-air RF coverage, built from GPS position packets and where the mesh heard them.
          Drive with a GPS node to fill in the map. <b>Signal</b> shows direct (zero-hop) reception colored
          by how strong it was; <b>Reach</b> adds relayed hits and colors each spot by the fewest hops it
          took to reach the network.
        </p>
      </div>
      {samples.length === 0 ? (
        <div className="card text-ink-faint">No coverage samples yet. They accumulate as GPS nodes are heard.</div>
      ) : (
        <CoverageHeatMap samples={samples} mode={mode} tile={await mapTiles()} channels={channels} filter={{ channelId, days }} defaultCenter={center} />
      )}
    </div>
  );
}
