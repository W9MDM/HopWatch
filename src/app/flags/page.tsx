import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { recentFlags, listKeyVerifications } from "../../db/queries.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { fmtLocal, fmtAge } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { cn } from "../../lib/cn.ts";
import { DbError } from "../../components/DbError.tsx";
import { AutoRefresh } from "../../components/AutoRefresh.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  spoof_pubkey: "Public-key spoof", identity_flap: "Identity flap", role_violation: "Role violation", anomaly: "Anomaly",
  // Conflicts that exist only BETWEEN nodes, plus the inverse of the role check.
  duplicate_pubkey: "Duplicate public key", duplicate_short_name: "Duplicate short name",
  router_not_relaying: "Router not relaying",
};
const SEV_TONE: Record<string, string> = { info: "text-ink-mute", warn: "text-gold-ink", critical: "text-accent-strong" };

export default async function FlagsPage() {
  const __denied = await moduleDenied("flags"); if (__denied) return __denied;
  let rows, verifications, zone = "UTC";
  try {
    zone = (await effectiveConfig()).server.local_timezone;
    rows = await recentFlags(200);
    // KEY_VERIFICATION_APP handshakes. Grouped by nonce, so an exchange that never reached its
    // final stage is visible: a verification that quietly did not complete leaves two operators
    // believing they have verified each other.
    verifications = await listKeyVerifications(100);
  } catch (e) {
    return <DbError error={e} />;
  }
  const open = rows.filter((r) => !r.resolved_at && !r.acknowledged_at).length;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="eyebrow"><span className="eyebrow-bar" />Flags &amp; anomalies</h1>
          <p className="mt-1 text-[13px] text-ink-faint">
            Integrity flags raised across the mesh: public-key spoofing, identity flapping, role
            violations, and anomalies. {open} open / unacknowledged.
          </p>
        </div>
        <AutoRefresh />
      </div>

      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr><th>When ({zone})</th><th>Type</th><th>Severity</th><th>Node</th><th>Short</th><th>Detail</th><th>Status</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="text-ink-faint">No flags raised.</td></tr>}
            {rows.map((f) => (
              <tr key={f.flag_id}>
                <td className="text-ink-mute" title={fmtLocal(f.created_at, zone)}>{fmtAge(f.created_at)}</td>
                <td>{TYPE_LABEL[f.flag_type] ?? f.flag_type}</td>
                <td className={cn("uppercase", SEV_TONE[f.severity] ?? "text-ink-mute")}>{f.severity}</td>
                <td><Link className="callsign" href={`/nodes/${f.node_id}`}>{f.name ?? formatNodeId(f.node_id)}</Link></td>
                <td className="mono text-ink-mute">{f.short_name ?? "-"}</td>
                <td className="text-ink-mute">{f.message}</td>
                <td className={f.resolved_at ? "text-ok" : f.acknowledged_at ? "text-ink-faint" : "text-accent-strong"}>
                  {f.resolved_at ? "resolved" : f.acknowledged_at ? "acknowledged" : "open"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-1">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Key verification</h2>
        <p className="text-[13px] text-ink-faint">
          PKI key-verification handshakes seen on the mesh (port 12), grouped by the nonce that
          correlates one exchange. Incomplete means the closing authoritative hash was never
          observed, so the verification did not finish. The hashes themselves are handshake material
          and are not recorded.
        </p>
      </div>
      {verifications.length === 0 ? (
        <div className="card text-ink-faint">No key-verification traffic observed.</div>
      ) : (
        <div className="card overflow-x-auto"><table className="data">
          <thead><tr><th>Started</th><th>Initiator</th><th>Peer</th><th>Stages seen</th><th>Result</th></tr></thead>
          <tbody>
            {verifications.map((v) => (
              <tr key={v.nonce}>
                <td className="text-ink-mute">{fmtAge(v.first_at)}</td>
                <td><Link className="callsign" href={`/nodes/${v.initiator}`}>{formatNodeId(v.initiator)}</Link></td>
                <td>{v.peer ? <Link className="callsign" href={`/nodes/${v.peer}`}>{formatNodeId(v.peer)}</Link> : <span className="text-ink-faint">-</span>}</td>
                <td className="mono text-ink-faint">{v.stages}</td>
                <td className={v.completed ? "text-ok" : "text-accent-strong"}>{v.completed ? "completed" : "incomplete"}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
