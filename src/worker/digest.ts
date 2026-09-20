import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { buildEventsIcs } from "../lib/ics.ts";
import { dispatch, type Channel } from "./delivery.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// Local date (YYYY-MM-DD) and HH:MM in the configured render timezone.
function localParts(tz: string): { date: string; hhmm: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}` };
}

export async function maybeRunDigest(cfg: HopWatchConfig): Promise<boolean> {
  if (!cfg.digest.enabled || cfg.digest.channels.length === 0) return false;
  const { date, hhmm } = localParts(cfg.server.local_timezone);
  if (hhmm < cfg.digest.time) return false;

  const [wm] = await query<{ last_bucket_folded: string | null }>(
    `SELECT last_bucket_folded FROM rollup_watermark WHERE rollup_name='digest'`,
  );
  const lastSent = wm?.last_bucket_folded ? wm.last_bucket_folded.slice(0, 10) : null;
  if (lastSent === date) return false; // already sent today

  await runDigest(cfg);
  await query(
    `INSERT INTO rollup_watermark (rollup_name, last_bucket_folded, updated_at) VALUES ('digest', ?, ?)
     ON DUPLICATE KEY UPDATE last_bucket_folded=VALUES(last_bucket_folded), updated_at=VALUES(updated_at)`,
    [toMysqlUtc(new Date()), toMysqlUtc(new Date())],
  );
  return true;
}

export async function runDigest(cfg: HopWatchConfig): Promise<void> {
  const brand = cfg.server.ui.brand_name;
  const [newNodes, silent, spoofs, mesh] = await Promise.all([
    query<{ node_id: number; long_name: string | null }>(
      `SELECT node_id, long_name FROM nodes WHERE first_seen_at > (UTC_TIMESTAMP() - INTERVAL 1 DAY) ORDER BY first_seen_at DESC LIMIT 50`,
    ),
    query<{ node_id: number; long_name: string | null }>(
      `SELECT node_id, long_name FROM nodes WHERE last_seen_at BETWEEN (UTC_TIMESTAMP() - INTERVAL 2 DAY) AND (UTC_TIMESTAMP() - INTERVAL 1 DAY) LIMIT 50`,
    ),
    query<{ node_id: number; message: string }>(
      `SELECT node_id, message FROM node_flags WHERE flag_type='spoof_pubkey' AND created_at > (UTC_TIMESTAMP() - INTERVAL 1 DAY) LIMIT 50`,
    ),
    query<{ total_receptions: number; active_nodes: number }>(
      `SELECT COALESCE(SUM(total_receptions),0) total_receptions, COALESCE(MAX(active_nodes),0) active_nodes
       FROM mesh_rollup_hour WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`,
    ),
  ]);

  // Section allowlist: empty = include every implemented section. Only the sections built
  // below are honored (new_nodes, silent_nodes, spoof_flags); unknown names are ignored.
  const inc = cfg.digest.include;
  const want = (k: string) => inc.length === 0 || inc.includes(k);

  const m = mesh[0] ?? { total_receptions: 0, active_nodes: 0 };
  const lines: string[] = [];
  lines.push(`${brand} daily digest`);
  lines.push("");
  lines.push(`Active nodes (24h): ${m.active_nodes}`);
  lines.push(`Receptions (24h): ${m.total_receptions}`);
  lines.push("");
  if (want("new_nodes")) {
    lines.push(`New nodes (${newNodes.length}):`);
    for (const n of newNodes) lines.push(`  - ${n.long_name ?? formatNodeId(n.node_id)}`);
  }
  if (want("silent_nodes")) {
    lines.push(`Gone silent (${silent.length}):`);
    for (const n of silent) lines.push(`  - ${n.long_name ?? formatNodeId(n.node_id)}`);
  }
  if (want("spoof_flags")) {
    lines.push(`Spoof flags (${spoofs.length}):`);
    for (const s of spoofs) lines.push(`  - ${formatNodeId(s.node_id)}: ${s.message}`);
  }

  const text = lines.join("\n");
  const html = `<pre style="font:13px ui-monospace,monospace">${escapeHtml(text)}</pre>`;

  const attachments = cfg.digest.attach_ics
    ? [{ filename: "hopwatch-events.ics", content: await buildEventsIcs(brand), contentType: "text/calendar" }]
    : undefined;

  await dispatch(cfg.digest.channels as Channel[], { title: `${brand} daily digest`, body: text, html, attachments }, cfg.alerts.delivery);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
