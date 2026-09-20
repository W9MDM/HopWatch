import type { HopWatchConfig } from "../config/schema.ts";
import { enqueueTx, txLog, outboxBacklog } from "../db/tx.ts";
import { scanCandidates, markScanned } from "../db/adminscan.ts";

// Proactive enqueuers pause while a backlog is draining, so they never outrun the send rate.
const BACKLOG_MAX = 12;

/**
 * Remote-admin scanner. Sends a DeviceMetadata admin request to recently-heard nodes that have not
 * been probed within interval_hours, through the station node (which PKI-encrypts it as an
 * authorized admin). Nodes that answer are recorded in remote_admin by the ingest daemon when the
 * response arrives on the node RX stream. Probing requires the armed TX subsystem; responses only
 * come back for nodes this station is actually authorized to admin.
 */
export async function runAdminScanner(cfg: HopWatchConfig): Promise<number> {
  const tx = cfg.tx;
  const sc = tx.admin_scanner;
  if (!tx.enabled || !tx.armed || tx.from_node <= 0 || !sc?.enabled) return 0;
  // Probing needs the station node (only it can PKI-encrypt admin). Skip if none is configured.
  if (!cfg.node.host) return 0;
  if (await outboxBacklog() > BACKLOG_MAX) return 0; // let the queue drain before probing more

  const targets = await scanCandidates(sc.max_per_run, sc.interval_hours, sc.max_active_age_hours, sc.reconfirm_hours);
  if (targets.length === 0) return 0;

  let n = 0;
  for (const t of targets) {
    if (t.node_id === (tx.from_node >>> 0)) continue; // never probe ourselves
    await enqueueTx({
      createdBy: `admin-scan:${t.node_id}`, transport: "node", kind: "admin_probe",
      channelId: null, toNode: t.node_id, fromNode: tx.from_node,
      hopLimit: tx.max_hop_limit, wantAck: false,
    });
    await markScanned(t.node_id);
    n++;
  }
  if (n) await txLog(`admin scanner probed ${n} node(s) for remote-admin access`);
  return n;
}
