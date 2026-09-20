import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { listPackets, distinctBrokers, type PacketFilter } from "../../db/queries.ts";
import { distinctChannels } from "../../db/settings.ts";
import { fmtLocal, fmtNode, fmtNum } from "../../lib/format.ts";
import { portName, PORT_NAMES } from "../../meshtastic/portnum.ts";
import { formatNodeId, parseNodeId } from "../../meshtastic/types.ts";
import { DbError } from "../../components/DbError.tsx";
import { AutoRefresh } from "../../components/AutoRefresh.tsx";
import { effectiveConfig } from "../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Packets" };

async function tz(): Promise<string> {
  try {
    return (await effectiveConfig()).server.local_timezone;
  } catch {
    return "UTC";
  }
}

type SP = Record<string, string | string[] | undefined>;

export default async function PacketsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("packets"); if (__denied) return __denied;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));

  const filter: PacketFilter = {
    fromNodeId: one("from") ? parseNodeId(one("from")!) : undefined,
    portNum: one("port") ? Number(one("port")) : undefined,
    decodeStatus: one("status") || undefined,
    broker: one("broker") || undefined,
    channelId: one("channel") || undefined,
    limit: one("limit") ? Number(one("limit")) : 100,
  };

  let rows, brokers: string[], channels: string[];
  try {
    [rows, brokers, channels] = await Promise.all([listPackets(filter), distinctBrokers(), distinctChannels()]);
  } catch (e) {
    return <DbError error={e} />;
  }

  const zone = await tz();
  const csvHref =
    "/api/v1/packets?format=csv" +
    (filter.fromNodeId ? `&from=${formatNodeId(filter.fromNodeId)}` : "") +
    (filter.portNum !== undefined ? `&port=${filter.portNum}` : "") +
    (filter.decodeStatus ? `&status=${filter.decodeStatus}` : "") +
    (filter.broker ? `&broker=${encodeURIComponent(filter.broker)}` : "") +
    (filter.channelId ? `&channel=${encodeURIComponent(filter.channelId)}` : "");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Packet browser
        </h1>
        <div className="flex items-center gap-2">
          <AutoRefresh />
          <a className="btn btn-outline h-8 px-3 text-[13px]" href={csvHref}>
            Export CSV
          </a>
        </div>
      </div>

      <form className="card flex flex-wrap items-end gap-3" method="get">
        <label className="space-y-1.5">
          <span className="block stat-label">From node</span>
          <input
            name="from"
            defaultValue={filter.fromNodeId ? formatNodeId(filter.fromNodeId) : ""}
            placeholder="!aabbccdd"
            className="h-9 w-40 rounded-md border border-line bg-raised px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Port</span>
          <select
            name="port"
            defaultValue={filter.portNum ?? ""}
            className="h-9 w-52 appearance-none rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none"
          >
            <option value="">any</option>
            {Object.entries(PORT_NAMES).map(([num, name]) => (
              <option key={num} value={num}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Decode</span>
          <select
            name="status"
            defaultValue={filter.decodeStatus ?? ""}
            className="h-9 w-36 appearance-none rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none"
          >
            <option value="">any</option>
            <option value="decoded">decoded</option>
            <option value="encrypted">encrypted</option>
            <option value="malformed">malformed</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Broker</span>
          <select
            name="broker"
            defaultValue={filter.broker ?? ""}
            className="h-9 w-40 appearance-none rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none"
          >
            <option value="">any</option>
            {brokers.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Channel</span>
          <select
            name="channel"
            defaultValue={filter.channelId ?? ""}
            className="h-9 w-40 appearance-none rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none"
          >
            <option value="">any</option>
            {channels.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary h-9 px-4 text-[13px]" type="submit">
          Apply
        </button>
      </form>

      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Received ({zone})</th>
              <th>From</th>
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
              <tr>
                <td colSpan={9} className="text-ink-faint">
                  No packets match.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} data-href={`/packets/${r.id}`} className="cursor-pointer hover:bg-raised">
                <td className="text-ink-mute">
                  <Link className="hover:text-ink" href={`/packets/${r.id}`}>
                    {fmtLocal(r.first_reception_at ?? r.first_seen_at, zone)}
                  </Link>
                </td>
                <td>
                  <Link className="callsign" href={`/packets?from=${formatNodeId(r.from_node_id)}`}>
                    {fmtNode(r.from_node_id, r.from_long_name, r.from_short_name)}
                  </Link>
                </td>
                <td className="mono text-ink-faint">
                  {r.to_node_id === null || r.to_node_id === 0xffffffff ? "broadcast" : formatNodeId(r.to_node_id)}
                </td>
                <td>{portName(r.port_num)}</td>
                <td className="text-ink-faint">{r.channel_id ?? "-"}</td>
                <td className="text-ink-faint">{r.source_broker_id ?? "-"}</td>
                <td className={r.decode_status === "decoded" ? "text-ok" : r.decode_status === "malformed" ? "text-accent-strong" : "text-ink-mute"}>
                  {r.decode_status}
                </td>
                <td className="text-right tabular-nums">{fmtNum(r.reception_count)}</td>
                <td className="text-ink-faint">{r.via_mqtt ? "mqtt" : "rf"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
