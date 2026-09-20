import { moduleDenied } from "../../components/ModuleGate.tsx";
import { effectiveConfig } from "../../db/appsettings.ts";
import { HistoryMap } from "../../components/HistoryMap.tsx";
import { mapTiles } from "../../lib/maptiles.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tz(): Promise<string> {
  try { return (await effectiveConfig()).server.local_timezone; } catch { return "UTC"; }
}

export default async function HistoryPage() {
  const __denied = await moduleDenied("history"); if (__denied) return __denied;
  // `now` is stamped server-side so the slider domain is stable for this render.
  const now = Date.now();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow"><span className="eyebrow-bar" />History</h1>
        <p className="mt-1 text-[13px] text-ink-faint">Scrub the map backward through time to see the network as it was.</p>
      </div>
      <HistoryMap tile={await mapTiles()} now={now} tz={await tz()} />
    </div>
  );
}
