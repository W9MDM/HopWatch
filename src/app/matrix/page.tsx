import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { getMatrix } from "../../db/queries.ts";
import { fmtNode } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { cn } from "../../lib/cn.ts";
import { utcToDate } from "../../lib/format.ts";
import { DbError } from "../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cell color = link status, dimmed by age of last-heard (spec: matrix colored by age).
function cellClass(status: string | undefined, last: string | null | undefined): string {
  if (!status || status === "never") return "bg-transparent";
  const d = utcToDate(last ?? null);
  const ageH = d ? (Date.now() - d.getTime()) / 3.6e6 : 9999;
  const opacity = ageH < 2 ? "" : ageH < 24 ? "/70" : ageH < 168 ? "/40" : "/20";
  const base = status === "direct" ? "bg-rx-direct" : status === "relayed" ? "bg-rx-relayed" : "bg-rx-mqtt";
  return base + opacity;
}

export default async function MatrixPage() {
  const __denied = await moduleDenied("matrix"); if (__denied) return __denied;
  let data;
  try {
    data = await getMatrix(60);
  } catch (e) {
    return <DbError error={e} />;
  }

  const cellIndex = new Map<string, { status: string; last_direct_at: string | null; last_relayed_at: string | null }>();
  for (const c of data.cells) {
    cellIndex.set(`${c.gateway_id}:${c.node_id}`, {
      status: c.status,
      last_direct_at: c.last_direct_at,
      last_relayed_at: c.last_relayed_at,
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Gateway x node matrix
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          {data.nodes.length} most-recent nodes across {data.gateways.length} gateways. Green direct, amber relayed,
          dimmed by age. Capped for legibility at scale.
        </p>
      </div>

      <div className="card overflow-x-auto">
        <table className="border-collapse text-[11px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-surface px-2 py-1 text-left text-ink-faint">node \ gateway</th>
              {data.gateways.map((g) => (
                <th key={g} className="px-1 py-1 text-ink-faint">
                  <span className="mono">{g.toString(16).slice(-4)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.nodes.map((n) => (
              <tr key={n.node_id}>
                <td className="sticky left-0 z-10 whitespace-nowrap bg-surface px-2 py-1">
                  <Link className="text-accent-strong" href={`/nodes/${n.node_id}`}>
                    {fmtNode(n.node_id, n.long_name, n.short_name)}
                  </Link>
                </td>
                {data.gateways.map((g) => {
                  const cell = cellIndex.get(`${g}:${n.node_id}`);
                  const last = cell?.status === "direct" ? cell?.last_direct_at : cell?.last_relayed_at;
                  return (
                    <td key={g} className="p-0.5">
                      <div
                        className={cn("h-4 w-4 rounded-sm", cellClass(cell?.status, last))}
                        title={cell ? `${formatNodeId(n.node_id)} <- ${formatNodeId(g)}: ${cell.status}` : "never"}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
