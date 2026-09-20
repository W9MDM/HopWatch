import { moduleDenied } from "../../../components/ModuleGate.tsx";
import { getHeardDirect } from "../../../db/queries.ts";
import { fmtAge, fmtNode, fmtNum, fmtRssi, fmtSnr } from "../../../lib/format.ts";
import { formatNodeId } from "../../../meshtastic/types.ts";
import { cn } from "../../../lib/cn.ts";
import { DbError } from "../../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusPill(status: string): string {
  return status === "active" ? "pill-on" : "pill-off";
}

export default async function GatewayDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const __denied = await moduleDenied("gateways"); if (__denied) return __denied;
  const { id } = await params;
  const gatewayId = Number(id);
  let rows;
  try {
    rows = await getHeardDirect(gatewayId);
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="eyebrow">
            <span className="eyebrow-bar" />
            Heard direct
          </h1>
          <p className="mono mt-1 text-[13px] text-ink-mute">{formatNodeId(gatewayId)}</p>
        </div>
        <a className="btn btn-outline h-8 px-3 text-[13px]" href={`/api/v1/gateways/${gatewayId}/heard-direct?format=csv`}>
          Export CSV
        </a>
      </div>

      <p className="text-[13px] text-ink-faint">
        Nodes this gateway received directly over RF (zero hops, RSSI/SNR present). Confirmed direct
        only. Self-gated and relayed receptions are excluded.
      </p>

      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Node</th>
              <th>Status</th>
              <th>Last heard</th>
              <th className="text-right">Receptions</th>
              <th className="text-right">RSSI avg</th>
              <th className="text-right">SNR avg</th>
              <th className="text-right">Last RSSI</th>
              <th className="text-right">Last SNR</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="text-ink-faint">
                  This gateway has not heard any node directly yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.node_id}>
                <td>
                  <a className="callsign" href={`/links/${gatewayId}/${r.node_id}`}>
                    {fmtNode(r.node_id, r.long_name, r.short_name)}
                  </a>
                </td>
                <td>
                  <span className={cn("pill", statusPill(r.status))}>{r.status}</span>
                </td>
                <td className="text-ink-mute">{fmtAge(r.last_heard_direct)}</td>
                <td className="text-right tabular-nums">{fmtNum(r.reception_count)}</td>
                <td className="text-right tabular-nums">{r.rssi_avg === null ? "-" : Math.round(r.rssi_avg)}</td>
                <td className="text-right tabular-nums">{r.snr_avg === null ? "-" : Number(r.snr_avg).toFixed(1)}</td>
                <td className="text-right tabular-nums">{fmtRssi(r.last_rssi)}</td>
                <td className="text-right tabular-nums">{fmtSnr(r.last_snr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
