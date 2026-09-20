// Pure parser for Mosquitto's text log, used to reconstruct which clients are currently connected
// to a broker (Mosquitto does not expose per-client identity over $SYS). DB-free and testable; the
// ingest collector (src/ingest/mqttclients.ts) reads the log file and persists the result.
//
// Log lines are `<unix_ts>: <message>`. We care about two shapes:
//   New client connected from <ip>:<port> as <client_id> (p5, c1, k30, u'<user>').
//   Client <client_id> has exceeded timeout, disconnecting.  (also: closed its connection / disconnected)
//   Socket error on client <client_id>, disconnecting.

export interface MqttLogEvent {
  ts: number; // unix seconds
  kind: "connect" | "disconnect";
  clientId: string;
  ip?: string;
  username?: string;
  keepalive?: number;
  protocol?: number;
}

// Greedy host capture so an IPv6 address (which contains colons) still splits correctly at ` :port as`.
const CONNECT = /^(\d+): New client connected from (.+):(\d+) as (.+?) \(p(\d+), c\d+, k(\d+)(?:, u'([^']*)')?\)/;
const DISCONNECT = /^(\d+): (?:Client (.+?) (?:has exceeded timeout, disconnecting|closed its connection|disconnected(?: due to [^.]*)?)|Socket error on client (.+?),)/;

export function parseMosquittoLog(text: string): MqttLogEvent[] {
  const out: MqttLogEvent[] = [];
  for (const line of text.split("\n")) {
    const c = CONNECT.exec(line);
    if (c) {
      out.push({ ts: Number(c[1]), kind: "connect", ip: c[2], clientId: c[4]!, protocol: Number(c[5]), keepalive: Number(c[6]), username: c[7] || undefined });
      continue;
    }
    const d = DISCONNECT.exec(line);
    if (d) {
      const id = d[2] ?? d[3];
      if (id && id !== "<unknown>") out.push({ ts: Number(d[1]), kind: "disconnect", clientId: id });
    }
  }
  return out;
}

export interface ConnectedClient {
  clientId: string;
  ip: string | null;
  username: string | null;
  keepalive: number | null;
  protocol: number | null;
  connectedAt: number;  // unix seconds of the current session's connect
  lastEventAt: number;
}

/**
 * Replay events (any order; sorted internally by ts) into the set of clients whose most recent event
 * is a connect. A client id that reconnects keeps only its latest session's connect time.
 */
export function connectedClients(events: MqttLogEvent[]): ConnectedClient[] {
  const sorted = events.slice().sort((a, b) => a.ts - b.ts || (a.kind === "disconnect" ? 1 : -1));
  const map = new Map<string, ConnectedClient & { connected: boolean }>();
  for (const e of sorted) {
    if (e.kind === "connect") {
      map.set(e.clientId, {
        clientId: e.clientId, ip: e.ip ?? null, username: e.username ?? null,
        keepalive: e.keepalive ?? null, protocol: e.protocol ?? null,
        connectedAt: e.ts, lastEventAt: e.ts, connected: true,
      });
    } else {
      const cur = map.get(e.clientId);
      if (cur) { cur.connected = false; cur.lastEventAt = e.ts; }
    }
  }
  return [...map.values()].filter((c) => c.connected).map(({ connected, ...c }) => c);
}

/** Normalize a Meshtastic node id to the `!hhhhhhhh` form. */
function normHex(s: string): string {
  return "!" + s.replace(/^!/, "").toLowerCase();
}

/**
 * Best-effort "what is this client" from its client id. Meshtastic phone apps connect as
 * `MeshtasticAndroidMqttProxy-!<nodeid>-<uuid>` / `...AppleMqttProxy...`; firmware gateways connect
 * as their node id (`!hhhhhhhh` or bare hex); HopWatch as `hopwatch-<broker>`. Everything else is
 * "other" (scanners, dashboards, generic MQTT tools). `node` is the mesh node id when we can tell.
 */
export function classifyClient(clientId: string): { kind: string; node: string | null } {
  if (/^hopwatch-/i.test(clientId)) return { kind: "hopwatch", node: null };
  const app = /^Meshtastic([A-Za-z]*)MqttProxy-(!?[0-9a-f]{8})/i.exec(clientId);
  if (app) return { kind: `app${app[1] ? ` (${app[1].toLowerCase()})` : ""}`, node: normHex(app[2]!) };
  if (/^!?[0-9a-f]{8}$/i.test(clientId)) return { kind: "node", node: normHex(clientId) };
  return { kind: "other", node: null };
}
