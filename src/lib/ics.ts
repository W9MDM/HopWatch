import ical from "ical-generator";
import { query } from "../db/client.ts";
import { utcToDate } from "./format.ts";
import { formatNodeId } from "../meshtastic/types.ts";

// Build an .ics calendar of recent mesh events (new nodes, spoof flags, fired alerts).
// Used by /feeds/events.ics and as a digest email attachment.
export async function buildEventsIcs(brand = "HopWatch"): Promise<string> {
  const cal = ical({ name: `${brand} events` });

  const newNodes = await query<{ node_id: number; long_name: string | null; first_seen_at: string }>(
    `SELECT node_id, long_name, first_seen_at FROM nodes
     WHERE first_seen_at > (UTC_TIMESTAMP() - INTERVAL 30 DAY) ORDER BY first_seen_at DESC LIMIT 500`,
  );
  for (const n of newNodes) {
    const start = utcToDate(n.first_seen_at);
    if (!start) continue;
    cal.createEvent({
      start,
      allDay: false,
      summary: `New node: ${n.long_name ?? formatNodeId(n.node_id)}`,
      description: `First heard ${formatNodeId(n.node_id)}`,
    });
  }

  const flags = await query<{ node_id: number; message: string; created_at: string }>(
    `SELECT node_id, message, created_at FROM node_flags
     WHERE flag_type='spoof_pubkey' AND created_at > (UTC_TIMESTAMP() - INTERVAL 30 DAY)
     ORDER BY created_at DESC LIMIT 500`,
  );
  for (const f of flags) {
    const start = utcToDate(f.created_at);
    if (!start) continue;
    cal.createEvent({ start, summary: `Spoof flag: ${formatNodeId(f.node_id)}`, description: f.message });
  }

  const alerts = await query<{ title: string; body: string; created_at: string }>(
    `SELECT title, body, created_at FROM alerts
     WHERE created_at > (UTC_TIMESTAMP() - INTERVAL 30 DAY) ORDER BY created_at DESC LIMIT 500`,
  );
  for (const a of alerts) {
    const start = utcToDate(a.created_at);
    if (!start) continue;
    cal.createEvent({ start, summary: a.title, description: a.body });
  }

  return cal.toString();
}
