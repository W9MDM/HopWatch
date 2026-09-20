import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { topRelays, strongestLinks, mostConnectedNodes } from "../../db/queries.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { fmtAge, fmtNum } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { cn } from "../../lib/cn.ts";
import { DbError } from "../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const relayByte = (b: number) => "0x" + (b & 0xff).toString(16).padStart(2, "0");

export default async function BackbonePage() {
  const __denied = await moduleDenied("backbone"); if (__denied) return __denied;
  let relays, links, connected, zone = "UTC";
  try {
    zone = (await effectiveConfig()).server.local_timezone;
    [relays, links, connected] = await Promise.all([topRelays(50), strongestLinks(50), mostConnectedNodes(30)]);
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow"><span className="eyebrow-bar" />Backbone</h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          The infrastructure carrying the mesh: the busiest relays, the most-observed links (from
          traceroutes), and the most-connected nodes by RF neighbours.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card overflow-x-auto">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Busiest relays</h2>
          <table className="data">
            <thead><tr><th>Relay byte</th><th>Candidate node(s)</th><th className="text-right">Evidence</th><th>Role</th></tr></thead>
            <tbody>
              {relays.length === 0 && <tr><td colSpan={4} className="text-ink-faint">No relay activity observed yet.</td></tr>}
              {relays.map((r) => (
                <tr key={r.relay_byte}>
                  <td className="mono">{relayByte(r.relay_byte)}</td>
                  <td>
                    {r.candidates.length === 0 ? <span className="text-ink-faint">unknown</span>
                      : r.candidates.length === 1
                        ? <Link className="callsign" href={`/nodes/${r.candidates[0]!.id}`}>{r.candidates[0]!.name ?? formatNodeId(r.candidates[0]!.id)}</Link>
                        : <span className="text-ink-mute">{r.candidates.length} candidates</span>}
                  </td>
                  <td className="text-right tabular-nums">{fmtNum(r.evidence_count)}</td>
                  <td className={cn(r.role_violation ? "text-accent-strong" : "text-ink-mute")}>
                    {r.claimed_role ?? "-"}{r.role_violation ? " (violation)" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-x-auto">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Most-connected nodes</h2>
          <table className="data">
            <thead><tr><th className="text-right">#</th><th>Node</th><th className="text-right">RF neighbours</th></tr></thead>
            <tbody>
              {connected.length === 0 && <tr><td colSpan={3} className="text-ink-faint">No neighbour info yet.</td></tr>}
              {connected.map((c, i) => (
                <tr key={c.node_id}>
                  <td className="text-right tabular-nums text-ink-faint">{i + 1}</td>
                  <td><Link className="callsign" href={`/nodes/${c.node_id}`}>{c.name ?? formatNodeId(c.node_id)}</Link></td>
                  <td className="text-right tabular-nums">{fmtNum(c.neighbors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Most-observed links</h2>
        <table className="data">
          <thead><tr><th>Link</th><th className="text-right">Times seen</th><th className="text-right">Last SNR</th><th>Last seen ({zone})</th></tr></thead>
          <tbody>
            {links.length === 0 && <tr><td colSpan={4} className="text-ink-faint">No traceroute-derived links yet.</td></tr>}
            {links.map((l) => (
              <tr key={`${l.a}-${l.b}`}>
                <td>
                  <Link className="callsign" href={`/nodes/${l.a}`}>{l.a_name ?? formatNodeId(l.a)}</Link>
                  <span className="text-ink-faint"> &harr; </span>
                  <Link className="callsign" href={`/nodes/${l.b}`}>{l.b_name ?? formatNodeId(l.b)}</Link>
                </td>
                <td className="text-right tabular-nums">{fmtNum(l.times_seen)}</td>
                <td className="text-right tabular-nums text-ink-mute">{l.last_snr == null ? "-" : `${l.last_snr.toFixed(1)} dB`}</td>
                <td className="text-ink-mute">{fmtAge(l.last_seen_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
