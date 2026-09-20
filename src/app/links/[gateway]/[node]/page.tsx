import { moduleDenied } from "../../../../components/ModuleGate.tsx";
import { getPairHistory } from "../../../../db/queries.ts";
import { formatNodeId } from "../../../../meshtastic/types.ts";
import { DbError } from "../../../../components/DbError.tsx";
import { TelemetryChart, type Series } from "../../../../components/TelemetryChart.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PairHistoryPage({ params }: { params: Promise<{ gateway: string; node: string }> }) {
  const __denied = await moduleDenied("gateways"); if (__denied) return __denied;
  const { gateway, node } = await params;
  const gatewayId = Number(gateway);
  const nodeId = Number(node);

  let history;
  try {
    history = await getPairHistory(gatewayId, nodeId, 168);
  } catch (e) {
    return <DbError error={e} />;
  }

  const rssi: Series = {
    label: "RSSI (dBm)",
    color: "#3f9e63",
    points: history.filter((h) => h.rssi !== null).map((h) => ({ t: h.t, v: Number(h.rssi) })),
  };
  const snr: Series = {
    label: "SNR (dB)",
    color: "#e0b43a",
    points: history.filter((h) => h.snr !== null).map((h) => ({ t: h.t, v: Number(h.snr) })),
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Link history
        </h1>
        <p className="mono mt-1 text-[13px] text-ink-mute">
          {formatNodeId(gatewayId)} heard {formatNodeId(nodeId)} (last 7 days, hourly)
        </p>
      </div>
      <div className="card">
        <h2 className="eyebrow mb-2">
          <span className="eyebrow-bar" />
          RSSI
        </h2>
        <TelemetryChart series={rssi} />
      </div>
      <div className="card">
        <h2 className="eyebrow mb-2">
          <span className="eyebrow-bar" />
          SNR
        </h2>
        <TelemetryChart series={snr} />
      </div>
    </div>
  );
}
