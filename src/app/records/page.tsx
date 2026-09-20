import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { getRecords } from "../../db/queries.ts";
import { fmtLocal } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { DbError } from "../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Records" };

const LABELS: Record<string, string> = {
  longest_direct_link_km: "Longest direct link",
  most_hops: "Most hops observed",
  fastest_traceroute_ms: "Fastest traceroute round trip",
  oldest_continuously_heard_days: "Oldest continuously heard",
  best_rssi_per_km: "Best RSSI per km (distance-adjusted)",
};

async function tz(): Promise<string> {
  try {
    return (await effectiveConfig()).server.local_timezone;
  } catch {
    return "UTC";
  }
}

function fmtValue(type: string, v: number): string {
  if (type === "longest_direct_link_km") return `${v.toFixed(1)} km`;
  if (type === "most_hops") return `${Math.round(v)} hops`;
  if (type === "fastest_traceroute_ms") return `${Math.round(v)} ms`;
  if (type === "oldest_continuously_heard_days") return `${v.toFixed(1)} days`;
  if (type === "best_rssi_per_km") return `${v.toFixed(1)} dB-adj`;
  return String(v);
}

export default async function RecordsPage() {
  const __denied = await moduleDenied("records"); if (__denied) return __denied;
  let rows;
  try {
    rows = await getRecords();
  } catch (e) {
    return <DbError error={e} />;
  }
  const zone = await tz();

  return (
    <div className="space-y-4">
      <h1 className="eyebrow">
        <span className="eyebrow-bar" />
        Records board
      </h1>
      {rows.length === 0 ? (
        <div className="card text-ink-faint">No records set yet. They compute as data arrives.</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {rows.map((r) => (
            <div key={r.record_type} className="card">
              <div className="stat-label">{LABELS[r.record_type] ?? r.record_type}</div>
              <div className="stat mt-1">{fmtValue(r.record_type, Number(r.value))}</div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                {r.node_a != null && (
                  <Link className="callsign" href={`/nodes/${r.node_a}`}>
                    {formatNodeId(r.node_a)}
                  </Link>
                )}
                {r.node_b != null && (
                  <Link className="callsign" href={`/nodes/${r.node_b}`}>
                    {formatNodeId(r.node_b)}
                  </Link>
                )}
                <span className="ml-auto">{fmtLocal(r.achieved_at, zone)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
