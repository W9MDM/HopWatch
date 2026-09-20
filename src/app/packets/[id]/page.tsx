import Link from "next/link";
import { getPacketDetail } from "../../../db/queries.ts";
import { fmtLocal, fmtNode, fmtRssi, fmtSnr } from "../../../lib/format.ts";
import { portName } from "../../../meshtastic/portnum.ts";
import { formatNodeId } from "../../../meshtastic/types.ts";
import { receptionClassMeta } from "../../../lib/rx.ts";
import { effectiveConfig } from "../../../db/appsettings.ts";
import { cn } from "../../../lib/cn.ts";
import { DbError } from "../../../components/DbError.tsx";
import { moduleDenied } from "../../../components/ModuleGate.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tz(): Promise<string> {
  try {
    return (await effectiveConfig()).server.local_timezone;
  } catch {
    return "UTC";
  }
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="stat-label">{label}</span>
      <span className={cn("text-ink", mono && "mono text-[12px]")}>{value}</span>
    </div>
  );
}

function Preview({ preview }: { preview: Awaited<ReturnType<typeof getPacketDetail>> extends infer T ? T extends { preview: infer P } ? P : never : never }) {
  switch (preview.kind) {
    case "position":
      return (
        <div className="mono text-[13px] text-ink">
          {preview.latitude.toFixed(6)}, {preview.longitude.toFixed(6)}
          {preview.altitude_m != null ? ` @ ${preview.altitude_m} m` : ""}
        </div>
      );
    case "telemetry":
      return (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-3">
          {preview.metrics.map((m) => (
            <div key={m.metric} className="flex justify-between text-[13px]">
              <span className="text-ink-mute">{m.metric}</span>
              <span className="tabular-nums text-ink">{m.value}</span>
            </div>
          ))}
        </div>
      );
    case "nodeinfo":
      return (
        <ul className="space-y-1 text-[13px]">
          {preview.changes.map((c, i) => (
            <li key={i}>
              <span className="text-ink">{c.event_type}</span>{" "}
              <span className="text-ink-mute">
                {c.old_value ? `${c.old_value} -> ` : ""}
                {c.new_value}
              </span>
            </li>
          ))}
        </ul>
      );
    case "traceroute":
      return (
        <div className="flex flex-wrap items-center gap-2">
          {preview.route.map((n, i) => (
            <span key={i} className="flex items-center gap-2">
              <span className="callsign">{formatNodeId(n)}</span>
              {i < preview.route.length - 1 && <span className="text-ink-faint">-&gt;</span>}
            </span>
          ))}
        </div>
      );
    case "json":
      return <pre className="mono overflow-x-auto text-[11px] text-ink-mute">{JSON.stringify(preview.raw, null, 2)}</pre>;
    case "encrypted":
      return <div className="text-[13px] text-ink-faint">Encrypted payload retained for re-decode when a matching key is added.</div>;
    default:
      return <div className="text-[13px] text-ink-faint">No decoded payload retained for this port.</div>;
  }
}

export default async function PacketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const __denied = await moduleDenied("packets"); if (__denied) return __denied;
  const { id } = await params;
  let detail;
  try {
    detail = await getPacketDetail(Number(id));
  } catch (e) {
    return <DbError error={e} />;
  }
  if (!detail) return <div className="card text-ink-mute">Unknown packet {id}.</div>;
  const zone = await tz();
  const p = detail.packet;
  // How HopWatch itself heard this packet (distinct from the mesh-path reception_class).
  const rfHeard = detail.receptions.some((r) => r.transport === "rf");
  const mqttHeard = detail.receptions.some((r) => r.transport === "mqtt");
  const heardVia = rfHeard && mqttHeard ? "RF + MQTT" : rfHeard ? "RF" : mqttHeard ? "MQTT" : "-";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Packet #{p.id}</h1>
        <p className="mono mt-1 text-[13px] text-ink-mute">
          from{" "}
          <Link className="text-accent-strong" href={`/nodes/${p.from_node_id}`}>
            {fmtNode(p.from_node_id, p.from_long_name, p.from_short_name)}
          </Link>{" "}
          · {portName(p.port_num)} · {p.decode_status} · {fmtLocal(p.first_reception_at ?? p.first_seen_at, zone)}
        </p>
      </div>

      <div className="card">
        <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Packet details</h2>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-[13px] md:grid-cols-3">
          <Field label="Mesh packet id" value={`0x${(p.mesh_packet_id >>> 0).toString(16)} (${p.mesh_packet_id >>> 0})`} mono />
          <Field label="From" value={`${fmtNode(p.from_node_id, p.from_long_name, p.from_short_name)} · ${formatNodeId(p.from_node_id)}`} />
          <Field label="To" value={p.to_node_id === null || p.to_node_id === 0xffffffff ? "broadcast" : formatNodeId(p.to_node_id)} mono />
          <Field label="Port" value={`${portName(p.port_num)}${p.port_num != null ? ` (${p.port_num})` : ""}`} />
          {/* channel_index is the PUBLISHER's local channel index, which is only meaningful for the
              station node's own RF receptions. It is NULL for an encrypted MQTT copy, whose
              MeshPacket.channel byte is the channel hash rather than an index (it used to be stored
              here and rendered as one, so a hash of 37 displayed as "LongFast [37]"). */}
          <Field label="Channel" value={`${p.channel_id ?? "-"}${p.channel_index != null ? ` (publisher index ${p.channel_index})` : ""}`} />
          <Field label="Decode" value={p.decode_status + (p.decode_error ? `: ${p.decode_error}` : "")} />
          <Field label="Payload format" value={p.payload_format ?? "-"} />
          <Field label="Source broker" value={p.source_broker_id ?? "-"} mono />
          <Field label="Heard via" value={heardVia} />
          <Field label="Sender uplink" value={p.via_mqtt ? "mqtt" : "rf"} />
          <Field label="Want ack" value={p.want_ack ? "yes" : "no"} />
          <Field label="OK to MQTT" value={p.ok_to_mqtt ? "yes" : "no"} />
          <Field label="Receptions" value={String(p.reception_count)} />
          <Field label="First seen" value={fmtLocal(p.first_seen_at, zone)} />
          <Field label="First reception" value={p.first_reception_at ? fmtLocal(p.first_reception_at, zone) : "-"} />
        </div>
      </div>

      <div className="card">
        <h2 className="eyebrow mb-3">
          <span className="eyebrow-bar" />
          Payload preview
        </h2>
        <Preview preview={detail.preview} />
      </div>

      <div className="card overflow-x-auto">
        <h2 className="eyebrow mb-3">
          <span className="eyebrow-bar" />
          Receptions ({detail.receptions.length})
        </h2>
        <table className="data">
          <thead>
            <tr>
              <th>Gateway</th>
              <th>Via</th>
              <th>Class</th>
              <th className="text-right">RSSI</th>
              <th className="text-right">SNR</th>
              <th className="text-right">Hops</th>
              <th className="text-right">Relay</th>
              <th>rx time ({zone})</th>
              <th>Topic</th>
            </tr>
          </thead>
          <tbody>
            {detail.receptions.map((r) => {
              const m = receptionClassMeta(r.reception_class);
              const hops = r.hop_start != null && r.hop_limit != null ? r.hop_start - r.hop_limit : null;
              return (
                <tr key={r.id}>
                  <td className="mono">
                    <Link className="text-accent-strong" href={`/gateways/${r.gateway_id}`}>
                      {formatNodeId(r.gateway_id)}
                    </Link>
                  </td>
                  <td className={r.transport === "rf" ? "text-ok" : "text-ink-mute"}>{r.transport === "rf" ? "RF" : "MQTT"}</td>
                  <td className={m.text}>
                    <span className={cn("mr-1 inline-block h-2 w-2 rounded-full align-middle", m.dot)} />
                    {m.label}
                  </td>
                  <td className="text-right tabular-nums">{fmtRssi(r.rx_rssi)}</td>
                  <td className="text-right tabular-nums">{fmtSnr(r.rx_snr)}</td>
                  <td className="text-right tabular-nums">{hops ?? "-"}</td>
                  <td className="text-right tabular-nums">{r.relay_node ? r.relay_node.toString(16) : "-"}</td>
                  <td className="text-ink-mute">{fmtLocal(r.rx_time, zone)}</td>
                  <td className="mono text-[11px] text-ink-faint">{r.raw_topic}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
