import Link from "next/link";
import { moduleDenied } from "../../../../components/ModuleGate.tsx";
import { getNodeHeader, listPackets, type PacketFilter } from "../../../../db/queries.ts";
import { effectiveConfig } from "../../../../db/appsettings.ts";
import { fmtLocal, fmtNum } from "../../../../lib/format.ts";
import { roleColor } from "../../../../lib/rx.ts";
import { portName } from "../../../../meshtastic/portnum.ts";
import { formatNodeId } from "../../../../meshtastic/types.ts";
import { NodeTabs } from "../../../../components/NodeTabs.tsx";
import { AutoRefresh } from "../../../../components/AutoRefresh.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Node packets" };

type SP = Record<string, string | string[] | undefined>;

const PAGE = 100;

export default async function NodePacketsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("nodes"); if (__denied) return __denied;
  const { id } = await params;
  const nodeId = Number(id);
  const sp = await searchParams;
  const before = Array.isArray(sp.before) ? sp.before[0] : sp.before;

  let node, rows, zone = "UTC";
  try {
    const filter: PacketFilter = { fromNodeId: nodeId, limit: PAGE, beforeId: before ? Number(before) : undefined };
    [node, rows] = await Promise.all([getNodeHeader(nodeId), listPackets(filter)]);
    zone = (await effectiveConfig()).server.local_timezone;
  } catch (e) {
    return <div className="card text-accent-strong">Failed to load packets: {(e as Error).message}</div>;
  }
  if (!node) return <div className="card text-ink-mute">Unknown node {formatNodeId(nodeId)}.</div>;

  const name = node.long_name ?? node.short_name ?? formatNodeId(nodeId);
  const older = rows.length === PAGE ? rows[rows.length - 1]!.id : null;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-ink">
          {name} <span className={`text-[13px] ${roleColor(node.role)}`}>{node.role ?? ""}</span>
        </h1>
        <p className="mt-1 text-[13px] text-ink-mute">
          Packets this node originated, newest first.
          <span className="ml-1 mono text-ink-faint">{formatNodeId(nodeId)}</span>
        </p>
      </div>

      <NodeTabs nodeId={nodeId} active="packets" />

      <div className="flex items-center justify-end gap-2">
        <AutoRefresh />
        <Link className="btn btn-outline h-8 px-3 text-[13px]" href={`/packets?from=${formatNodeId(nodeId)}`}>Open in packet browser</Link>
        <a className="btn btn-outline h-8 px-3 text-[13px]" href={`/api/v1/packets?format=csv&from=${formatNodeId(nodeId)}`}>Export CSV</a>
      </div>

      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Received ({zone})</th>
              <th>To</th>
              <th>Port</th>
              <th>Channel</th>
              <th>Broker</th>
              <th>Decode</th>
              <th className="text-right">Receptions</th>
              <th>Via</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="text-ink-faint">No packets from this node yet.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-raised">
                <td className="text-ink-mute">
                  <Link className="hover:text-ink" href={`/packets/${r.id}`}>{fmtLocal(r.first_reception_at ?? r.first_seen_at, zone)}</Link>
                </td>
                <td className="mono text-ink-faint">
                  {r.to_node_id === null || r.to_node_id === 0xffffffff ? "broadcast" : formatNodeId(r.to_node_id)}
                </td>
                <td>{portName(r.port_num)}</td>
                <td className="text-ink-faint">{r.channel_id ?? "-"}</td>
                <td className="text-ink-faint">{r.source_broker_id ?? "-"}</td>
                <td className={r.decode_status === "decoded" ? "text-ok" : r.decode_status === "malformed" ? "text-accent-strong" : "text-ink-mute"}>{r.decode_status}</td>
                <td className="text-right tabular-nums">{fmtNum(r.reception_count)}</td>
                <td className="text-ink-faint">{r.via_mqtt ? "mqtt" : "rf"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {older !== null && (
        <div className="flex justify-center">
          <Link className="btn btn-outline h-8 px-4 text-[13px]" href={`/nodes/${nodeId}/packets?before=${older}`}>Show older</Link>
        </div>
      )}
    </div>
  );
}
