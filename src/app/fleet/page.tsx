import Link from "next/link";
import { moduleDenied } from "../../components/ModuleGate.tsx";
import { getFleet } from "../../db/queries.ts";
import { fmtNum, fmtAge } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { DbError } from "../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function Distribution({ title, rows }: { title: string; rows: { label: string; c: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.c));
  return (
    <div className="card">
      <h2 className="eyebrow mb-3">
        <span className="eyebrow-bar" />
        {title}
      </h2>
      <div className="space-y-1.5">
        {rows.length === 0 && <p className="text-[13px] text-ink-faint">No data.</p>}
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2 text-[13px]">
            <span className="w-40 truncate text-ink-mute" title={r.label}>{r.label}</span>
            <div className="h-3 flex-1 rounded bg-raised">
              <div className="h-3 rounded bg-rx-direct" style={{ width: `${Math.round((r.c / max) * 100)}%` }} />
            </div>
            <span className="w-12 text-right tabular-nums text-ink-faint">{fmtNum(r.c)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function FleetPage() {
  const __denied = await moduleDenied("fleet"); if (__denied) return __denied;
  let data;
  try {
    data = await getFleet();
  } catch (e) {
    return <DbError error={e} />;
  }

  const stats = [
    { label: "Known nodes", value: data.total },
    { label: "Active (24h)", value: data.active24 },
    { label: "Gateways", value: data.gateways },
    { label: "Positioned", value: data.positioned },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Fleet composition
        </h1>
        <p className="mt-1 text-[13px] text-ink-faint">What is out there: hardware, firmware, roles, channel activity, and the radio profile nodes self-report on the map topic.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="card">
            <div className="stat-label">{s.label}</div>
            <div className="stat mt-1 text-base">{fmtNum(s.value)}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Distribution title="Hardware model" rows={data.hardware} />
        <Distribution title="Firmware version" rows={data.firmware} />
        <Distribution title="Role" rows={data.roles} />
        <Distribution title="Channels (nodes active, 7d)" rows={data.channels} />
        {/* Radio profile, from MAP_REPORT_APP. A node on a region or preset that differs from the
            rest of the mesh is visible over MQTT but cannot be heard on RF, which without this looks
            exactly like a node with a bad antenna. Only map-reporting nodes appear here. */}
        <Distribution title="Region (self-reported)" rows={data.regions} />
        <Distribution title="Modem preset (self-reported)" rows={data.presets} />
      </div>

      <div className="card">
        <h2 className="eyebrow mb-2"><span className="eyebrow-bar" />Still on the default channel</h2>
        <p className="mb-2 text-[13px] text-ink-faint">
          Nodes whose own map report says they are using the public default channel PSK. Only nodes
          that opted in to map reporting are visible here.
        </p>
        {data.defaultChannelNodes.length === 0 ? (
          <p className="text-[13px] text-ink-faint">None reported.</p>
        ) : (
          <div className="overflow-x-auto"><table className="data">
            <thead><tr><th>Node</th><th>Short</th><th>Reported</th></tr></thead>
            <tbody>
              {data.defaultChannelNodes.map((n) => (
                <tr key={n.node_id}>
                  <td><Link className="callsign" href={`/nodes/${n.node_id}`}>{n.long_name ?? formatNodeId(n.node_id)}</Link></td>
                  <td className="mono text-ink-mute">{n.short_name ?? "-"}</td>
                  <td className="text-ink-mute">{fmtAge(n.reported_at)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
