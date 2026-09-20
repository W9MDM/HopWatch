// Read-side queries for the web/API. Dashboard counters come from rollups, never
// full-table scans (spec §3). All reads go through the shared pool.
import { query, clampLimit } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { haversineKm } from "../lib/geo.ts";

export interface PacketFilter {
  fromNodeId?: number;
  portNum?: number;
  decodeStatus?: string;
  broker?: string; // packets.source_broker_id
  channelId?: string; // packets.channel_id
  fromTime?: string; // MySQL UTC literal
  toTime?: string;
  limit?: number;
  beforeId?: number; // cursor
  includeMuted?: boolean; // default false: muted nodes hidden from default views
}

export interface PacketRow {
  id: number;
  first_seen_at: string;
  first_reception_at: string | null;
  mesh_packet_id: number;
  from_node_id: number;
  from_long_name: string | null;
  from_short_name: string | null;
  to_node_id: number | null;
  port_num: number | null;
  channel_id: string | null;
  source_broker_id: string | null;
  decode_status: string;
  reception_count: number;
  via_mqtt: number;
}

export async function listPackets(f: PacketFilter): Promise<PacketRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.fromNodeId !== undefined) { where.push("p.from_node_id = ?"); params.push(f.fromNodeId); }
  if (f.portNum !== undefined) { where.push("p.port_num = ?"); params.push(f.portNum); }
  if (f.decodeStatus) { where.push("p.decode_status = ?"); params.push(f.decodeStatus); }
  if (f.broker) { where.push("p.source_broker_id = ?"); params.push(f.broker); }
  if (f.channelId) { where.push("p.channel_id = ?"); params.push(f.channelId); }
  if (f.fromTime) { where.push("p.first_seen_at >= ?"); params.push(f.fromTime); }
  if (f.toTime) { where.push("p.first_seen_at < ?"); params.push(f.toTime); }
  if (f.beforeId !== undefined) { where.push("p.id < ?"); params.push(f.beforeId); }
  if (!f.includeMuted) where.push("(n.mute_hidden = 0 OR n.mute_hidden IS NULL)");
  const limit = clampLimit(f.limit ?? 100, 1000);
  const sql = `
    SELECT p.id, p.first_seen_at, p.first_reception_at, p.mesh_packet_id, p.from_node_id,
           n.long_name AS from_long_name, n.short_name AS from_short_name,
           p.to_node_id, p.port_num, p.channel_id, p.source_broker_id, p.decode_status, p.reception_count, p.via_mqtt
    FROM packets p
    LEFT JOIN nodes n ON n.node_id = p.from_node_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY p.id DESC
    LIMIT ${limit}`;
  return query<PacketRow>(sql, params);
}

export async function getBatteryForecast(nodeId: number): Promise<{ power_profile: string; slope_v_per_day: number | null; current_voltage: number | null; projected_dead_at: string | null; confidence: number | null } | null> {
  const rows = await query<{ power_profile: string; slope_v_per_day: number | null; current_voltage: number | null; projected_dead_at: string | null; confidence: number | null }>(
    `SELECT power_profile, slope_v_per_day, current_voltage, projected_dead_at, confidence FROM battery_forecast WHERE node_id=?`,
    [nodeId],
  );
  return rows[0] ?? null;
}

export interface CoverageNode { node_id: number; long_name: string | null; short_name: string | null; role: string | null; is_gateway: number; latitude: number; longitude: number; direct_gateways: number; best_rssi: number | null; altitude_m: number | null; rf_height_m: number | null; rf_eirp_dbm: number | null; heard_by?: HeardEntry[] }

export async function getCoverage(filter: MapFilter = {}): Promise<CoverageNode[]> {
  const m = packetMembership(filter);
  const nodes = await query<CoverageNode>(
    `SELECT n.node_id, n.long_name, n.short_name, n.role, n.is_gateway, np.latitude, np.longitude, np.altitude_m,
            n.rf_height_m, n.rf_eirp_dbm,
            -- Broker-scoped like /map's equivalents: on a broker-filtered view these counts must
            -- describe that broker's vantage, not every broker's.
            (SELECT COUNT(*) FROM gateway_node_link g JOIN gateways gwb ON gwb.gateway_id=g.gateway_id
              WHERE g.node_id=n.node_id AND g.direct_count>0${filter.broker ? " AND gwb.broker_id = ?" : ""}) AS direct_gateways,
            (SELECT MAX(g.last_rssi) FROM gateway_node_link g JOIN gateways gwb ON gwb.gateway_id=g.gateway_id
              WHERE g.node_id=n.node_id AND g.direct_count>0${filter.broker ? " AND gwb.broker_id = ?" : ""}) AS best_rssi
     FROM node_positions np JOIN nodes n ON n.node_id=np.node_id
     WHERE np.latitude IS NOT NULL AND np.longitude IS NOT NULL AND (n.position_ignored = 0 OR n.position_ignored IS NULL)${m.sql}`,
    filter.broker ? [filter.broker, filter.broker, ...m.params] : m.params,
  );
  // The broker filter has to reach here too: heard_by is not cosmetic on /coverage, where
  // CoverageMap uses it as the "RF only" marker filter and renders it in the popup, so an unfiltered
  // call made the page's broker control only half apply.
  const hb = await heardByMap(filter.broker);
  for (const n of nodes) n.heard_by = hb.get(n.node_id) ?? [];
  return nodes;
}

export async function linkAsymmetry(limit = 50): Promise<{ a: number; b: number; a_name: string | null; b_name: string | null; rssi_ab: number | null; rssi_ba: number | null; delta: number }[]> {
  return query(
    `SELECT a.gateway_id AS a, a.node_id AS b, na.long_name AS a_name, nb.long_name AS b_name,
            a.last_rssi AS rssi_ab, b.last_rssi AS rssi_ba,
            ABS(COALESCE(a.last_rssi,0) - COALESCE(b.last_rssi,0)) AS delta
     FROM gateway_node_link a
     JOIN gateway_node_link b ON b.gateway_id=a.node_id AND b.node_id=a.gateway_id
     LEFT JOIN nodes na ON na.node_id=a.gateway_id
     LEFT JOIN nodes nb ON nb.node_id=a.node_id
     WHERE a.direct_count>0 AND b.direct_count>0 AND a.gateway_id < a.node_id
       AND a.last_rssi IS NOT NULL AND b.last_rssi IS NOT NULL
     ORDER BY delta DESC LIMIT ${clampLimit(limit, 200)}`,
  );
}

export async function topTalkers(hours = 24, limit = 50): Promise<{ node_id: number; long_name: string | null; packets: number; receptions: number }[]> {
  return query(
    `SELECT r.node_id, n.long_name, SUM(r.packet_count) AS packets, SUM(r.reception_count) AS receptions
     FROM node_rollup_hour r LEFT JOIN nodes n ON n.node_id=r.node_id
     WHERE r.bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
     GROUP BY r.node_id ORDER BY packets DESC LIMIT ${clampLimit(limit, 200)}`,
    [hours],
  );
}

export async function airtimeHogs(limit = 50): Promise<{ node_id: number; long_name: string | null; air_util_tx: number }[]> {
  return query(
    `SELECT t.node_id, n.long_name, t.value AS air_util_tx
     FROM node_telemetry t
     JOIN (SELECT node_id, MAX(observed_at) mo FROM node_telemetry
           WHERE metric='air_util_tx' AND observed_at > (UTC_TIMESTAMP() - INTERVAL 6 HOUR) GROUP BY node_id) x
       ON x.node_id=t.node_id AND x.mo=t.observed_at
     LEFT JOIN nodes n ON n.node_id=t.node_id
     WHERE t.metric='air_util_tx' ORDER BY t.value DESC LIMIT ${clampLimit(limit, 200)}`,
  );
}

export interface NewNodeRow { node_id: number; long_name: string | null; short_name: string | null; first_seen_at: string; reviewed_at: string | null; spam_score: number | null; best_status: string | null; first_gateway: number | null }

export async function newNodeFeed(days = 7): Promise<NewNodeRow[]> {
  return query<NewNodeRow>(
    `SELECT n.node_id, n.long_name, n.short_name, n.first_seen_at, n.reviewed_at, n.spam_score,
            (SELECT g.status FROM gateway_node_link g WHERE g.node_id=n.node_id ORDER BY (g.status='direct') DESC LIMIT 1) AS best_status,
            (SELECT g.gateway_id FROM gateway_node_link g WHERE g.node_id=n.node_id ORDER BY COALESCE(g.first_direct_at, g.first_relayed_at) ASC LIMIT 1) AS first_gateway
     FROM nodes n
     WHERE n.first_seen_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     ORDER BY n.first_seen_at DESC LIMIT 300`,
    [days],
  );
}

export async function getTerrainLinkBudget(a: number, b: number): Promise<{ distance_km: number | null; expected_path_loss_db: number | null; fresnel_clearance: number | null; observed_rssi: number | null; deficit_db: number | null; profile: any } | null> {
  const rows = await query<{ distance_km: number | null; expected_path_loss_db: number | null; fresnel_clearance: number | null; observed_rssi: number | null; deficit_db: number | null; profile: any }>(
    `SELECT distance_km, expected_path_loss_db, fresnel_clearance, observed_rssi, deficit_db, profile
     FROM terrain_link_budget WHERE node_a=? AND node_b=?`,
    [a, b],
  );
  const r = rows[0];
  if (!r) return null;
  return { ...r, profile: typeof r.profile === "string" ? JSON.parse(r.profile) : r.profile };
}

export interface PacketDetail {
  packet: PacketRow & { channel_index: number | null; decode_error: string | null; raw_json: any; want_ack: number; ok_to_mqtt: number; payload_format: string | null };
  receptions: {
    id: number; gateway_id: number; rx_time: string; rx_rssi: number | null; rx_snr: number | null;
    hop_start: number | null; hop_limit: number | null; relay_node: number | null; reception_class: string;
    raw_topic: string; source_broker_id: string; is_json: number; transport: string;
  }[];
  preview:
    | { kind: "position"; latitude: number; longitude: number; altitude_m: number | null }
    | { kind: "telemetry"; metrics: { metric: string; value: number }[] }
    | { kind: "nodeinfo"; changes: { event_type: string; old_value: string | null; new_value: string | null }[] }
    | { kind: "traceroute"; route: number[] }
    | { kind: "json"; raw: any }
    | { kind: "encrypted" }
    | { kind: "none" };
}

export async function getPacketDetail(packetId: number): Promise<PacketDetail | null> {
  const prows = await query<PacketDetail["packet"]>(
    `SELECT p.id, p.first_seen_at, p.first_reception_at, p.mesh_packet_id, p.from_node_id, n.long_name AS from_long_name,
            n.short_name AS from_short_name, p.to_node_id, p.port_num, p.channel_id, p.channel_index, p.source_broker_id,
            p.decode_status, p.decode_error, p.reception_count, p.via_mqtt, p.want_ack, p.ok_to_mqtt, p.payload_format, p.raw_json
     FROM packets p LEFT JOIN nodes n ON n.node_id=p.from_node_id WHERE p.id=? LIMIT 1`,
    [packetId],
  );
  const packet = prows[0];
  if (!packet) return null;

  const receptions = await query<PacketDetail["receptions"][number]>(
    `SELECT id, gateway_id, rx_time, rx_rssi, rx_snr, hop_start, hop_limit, relay_node,
            reception_class, raw_topic, source_broker_id, is_json, transport
     FROM receptions WHERE packet_id=? ORDER BY (reception_class='rf_direct') DESC, rx_rssi DESC LIMIT 200`,
    [packetId],
  );

  let preview: PacketDetail["preview"] = { kind: "none" };
  const port = packet.port_num;
  if (packet.decode_status === "encrypted") {
    preview = { kind: "encrypted" };
  } else if (packet.raw_json) {
    preview = { kind: "json", raw: typeof packet.raw_json === "string" ? JSON.parse(packet.raw_json) : packet.raw_json };
  } else if (port === 3) {
    const r = await query<{ latitude: number; longitude: number; altitude_m: number | null }>(
      `SELECT latitude, longitude, altitude_m FROM node_position_events WHERE source_packet_id=? LIMIT 1`,
      [packetId],
    );
    if (r[0]) preview = { kind: "position", ...r[0] };
  } else if (port === 67) {
    const r = await query<{ metric: string; value: number }>(
      `SELECT metric, value FROM node_telemetry WHERE source_packet_id=?`,
      [packetId],
    );
    if (r.length) preview = { kind: "telemetry", metrics: r };
  } else if (port === 4) {
    const r = await query<{ event_type: string; old_value: string | null; new_value: string | null }>(
      `SELECT event_type, old_value, new_value FROM node_identity_events WHERE source_packet_id=?`,
      [packetId],
    );
    if (r.length) preview = { kind: "nodeinfo", changes: r };
  } else if (port === 70) {
    const r = await query<{ route: string | null }>(`SELECT route FROM link_events WHERE source_packet_id=? LIMIT 1`, [packetId]);
    if (r[0]?.route) preview = { kind: "traceroute", route: JSON.parse(r[0].route) as number[] };
  }

  return { packet, receptions, preview };
}

export interface DashboardData {
  latestHour: Record<string, unknown> | null;
  activeNodes24h: number;
  totalNodes: number;
  gateways: number;
  directPairs: number;
  receptions24h: number;
  packets24h: number;
  brokers: BrokerHealthRow[];
}

export interface BrokerHealthRow {
  broker_id: string;
  connected: number;
  last_message_at: string | null;
  messages: number;
  malformed: number;
  reconnects: number;
  updated_at: string | null;
}

export async function getDashboard(): Promise<DashboardData> {
  const [latest] = await query(
    `SELECT * FROM mesh_rollup_hour ORDER BY bucket_start DESC LIMIT 1`,
  );
  const [agg] = await query<{ receptions: number; packets: number; active: number }>(
    `SELECT COALESCE(SUM(total_receptions),0) receptions, COALESCE(SUM(total_packets),0) packets,
            COALESCE(MAX(active_nodes),0) active
     FROM mesh_rollup_hour WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`,
  );
  const [nodes] = await query<{ c: number }>(`SELECT COUNT(*) c FROM nodes`);
  const [gws] = await query<{ c: number }>(`SELECT COUNT(*) c FROM gateways WHERE active=1`);
  const [pairs] = await query<{ c: number }>(`SELECT COUNT(*) c FROM gateway_heard_direct`);
  const brokers = await query<BrokerHealthRow>(`SELECT * FROM broker_health ORDER BY broker_id`);

  return {
    latestHour: latest ?? null,
    activeNodes24h: Number(agg?.active ?? 0),
    totalNodes: Number(nodes?.c ?? 0),
    gateways: Number(gws?.c ?? 0),
    directPairs: Number(pairs?.c ?? 0),
    receptions24h: Number(agg?.receptions ?? 0),
    packets24h: Number(agg?.packets ?? 0),
    brokers,
  };
}

export interface MeshTrendPoint { bucket_start: string; active_nodes: number; delivery_ratio: number | null; avg_chan_util: number | null; new_nodes: number; total_packets: number }

/** Hourly mesh trend series for dashboard sparklines. */
export async function meshTrends(hours = 48): Promise<MeshTrendPoint[]> {
  return query<MeshTrendPoint>(
    `SELECT bucket_start, active_nodes, delivery_ratio, avg_chan_util, new_nodes, total_packets
     FROM mesh_rollup_hour
     WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND bucket_start <= UTC_TIMESTAMP()
     ORDER BY bucket_start ASC`,
    [hours],
  );
}

export interface TextStats {
  total: number;
  topSenders: { node_id: number; name: string | null; short_name: string | null; c: number }[];
  byBroker: { broker: string; c: number }[];
}

/** Text-message (TEXT_MESSAGE_APP) activity since an instant (one row per logical message):
 * total count, top senders by user, and a per-broker breakdown. Powers the dashboard card. */
export async function getTextStats(since: Date, topLimit = 10): Promise<TextStats> {
  const s = toMysqlUtc(since);
  const [tot] = await query<{ c: number }>(`SELECT COUNT(*) c FROM text_message WHERE observed_at >= ?`, [s]);
  const topSenders = await query<{ node_id: number; name: string | null; short_name: string | null; c: number }>(
    `SELECT t.from_node_id AS node_id, COALESCE(n.long_name, n.short_name) AS name, n.short_name AS short_name, COUNT(*) AS c
     FROM text_message t LEFT JOIN nodes n ON n.node_id = t.from_node_id
     WHERE t.observed_at >= ?
     GROUP BY t.from_node_id ORDER BY c DESC LIMIT ${clampLimit(topLimit, 50)}`,
    [s],
  );
  const byBroker = await query<{ broker: string; c: number }>(
    `SELECT COALESCE(source_broker_id, '(unknown)') AS broker, COUNT(*) AS c
     FROM text_message WHERE observed_at >= ?
     GROUP BY broker ORDER BY c DESC`,
    [s],
  );
  return { total: Number(tot?.c ?? 0), topSenders, byBroker };
}

/** Station-node RF receive health (broker_health row "node"), or null when RX is disabled.
 * Powers the navbar RF-node chip and the health page. */
export async function getNodeRxHealth(): Promise<{ connected: number; last_message_at: string | null; messages: number } | null> {
  const [r] = await query<{ connected: number; last_message_at: string | null; messages: number }>(
    `SELECT connected, last_message_at, messages FROM broker_health WHERE broker_id='node'`,
  );
  return r ?? null;
}

/** Encryption posture: how many known nodes advertise a public key. */
export async function pkiAdoption(): Promise<{ total: number; with_key: number }> {
  const [r] = await query<{ total: number; with_key: number }>(
    `SELECT COUNT(*) total, SUM(public_key_hex IS NOT NULL AND public_key_hex <> '') with_key FROM nodes`,
  );
  return { total: Number(r?.total ?? 0), with_key: Number(r?.with_key ?? 0) };
}

export interface HeardDirectRow {
  gateway_id: number;
  node_id: number;
  long_name: string | null;
  short_name: string | null;
  first_heard_direct: string;
  last_heard_direct: string;
  reception_count: number;
  rssi_avg: number | null;
  snr_avg: number | null;
  last_rssi: number | null;
  last_snr: number | null;
  status: string;
}

export async function getHeardDirect(gatewayId: number): Promise<HeardDirectRow[]> {
  return query<HeardDirectRow>(
    `SELECT g.gateway_id, g.node_id, n.long_name, n.short_name, g.first_heard_direct, g.last_heard_direct,
            g.reception_count, g.rssi_avg, g.snr_avg, g.last_rssi, g.last_snr, g.status
     FROM gateway_heard_direct g
     LEFT JOIN nodes n ON n.node_id = g.node_id
     WHERE g.gateway_id = ?
     ORDER BY g.last_heard_direct DESC`,
    [gatewayId],
  );
}

export async function listGateways(opts: { broker?: string; channelId?: string } = {}): Promise<{ gateway_id: number; long_name: string | null; short_name: string | null; last_seen_at: string | null; direct_nodes: number; broker_id: string | null }[]> {
  const params: unknown[] = [];
  let brokerClause = "";
  if (opts.broker) { brokerClause = " AND gw.broker_id = ?"; params.push(opts.broker); }
  let channelClause = "";
  if (opts.channelId) {
    channelClause = " AND EXISTS (SELECT 1 FROM receptions r JOIN packets pk ON pk.id = r.packet_id WHERE r.gateway_id = gw.gateway_id AND pk.channel_id = ?)";
    params.push(opts.channelId);
  }
  return query(
    `SELECT gw.gateway_id, n.long_name, n.short_name, gw.last_seen_at, gw.broker_id,
            (SELECT COUNT(*) FROM gateway_heard_direct d WHERE d.gateway_id = gw.gateway_id) AS direct_nodes
     FROM gateways gw LEFT JOIN nodes n ON n.node_id = gw.gateway_id
     WHERE gw.active=1${brokerClause}${channelClause}
     ORDER BY COALESCE(n.long_name, n.short_name) IS NULL, COALESCE(n.long_name, n.short_name), gw.gateway_id`,
    params,
  );
}

export interface BrokerPresence {
  broker_id: string;
  ingest_connected: number;          // is HopWatch's own subscriber connected to this broker
  last_message_at: string | null;    // last mesh message we ingested from it
  reconnects: number;
  clients_connected: number | null;  // $SYS: clients connected to the broker right now
  clients_active: number | null;
  clients_total: number | null;
  clients_disconnected: number | null;
  uptime_s: number | null;
  version: string | null;
  sys_updated_at: string | null;     // when we last got a $SYS reading (null = broker hides $SYS)
  gateways_total: number;            // gateways observed publishing through this broker
  gateways_active_15m: number;
  gateways_active_1h: number;
  last_gateway_seen: string | null;
}

/**
 * Per-broker presence for the /brokers page. Driven off broker_health (which has a row for every
 * configured broker), left-joined to the $SYS snapshot and the observed-gateway counts. The 'node'
 * pseudo-broker (the RF station node, not an MQTT broker) is excluded.
 */
export async function brokerPresence(): Promise<BrokerPresence[]> {
  return query<BrokerPresence>(
    `SELECT h.broker_id,
            h.connected AS ingest_connected, h.last_message_at, h.reconnects,
            s.clients_connected, s.clients_active, s.clients_total, s.clients_disconnected,
            s.uptime_s, s.version, s.updated_at AS sys_updated_at,
            (SELECT COUNT(*) FROM gateways g WHERE g.broker_id = h.broker_id) AS gateways_total,
            (SELECT COUNT(*) FROM gateways g WHERE g.broker_id = h.broker_id
               AND g.last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 15 MINUTE)) AS gateways_active_15m,
            (SELECT COUNT(*) FROM gateways g WHERE g.broker_id = h.broker_id
               AND g.last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 1 HOUR)) AS gateways_active_1h,
            (SELECT MAX(g.last_seen_at) FROM gateways g WHERE g.broker_id = h.broker_id) AS last_gateway_seen
     FROM broker_health h LEFT JOIN broker_sys s ON s.broker_id = h.broker_id
     WHERE h.broker_id <> 'node'
     ORDER BY h.broker_id`,
  );
}

export interface MqttClientRow {
  broker_id: string;
  client_id: string;
  username: string | null;
  keepalive_s: number | null;
  kind: string | null;
  node_id: number | null;
  long_name: string | null;
  short_name: string | null;
  connected_at: string | null;
  last_event_at: string | null;
}

/**
 * Clients currently connected to a broker, reconstructed by the ingest daemon from the broker's log
 * (populated only for a broker with a configured, readable log_file). node_id/names are resolved
 * when the client id encodes a mesh node (phone-app proxies, firmware gateways).
 */
export async function mqttClients(brokerId: string): Promise<MqttClientRow[]> {
  return query<MqttClientRow>(
    `SELECT c.broker_id, c.client_id, c.username, c.keepalive_s, c.kind, c.node_id,
            n.long_name, n.short_name, c.connected_at, c.last_event_at
     FROM mqtt_client c LEFT JOIN nodes n ON n.node_id = c.node_id
     WHERE c.broker_id = ?
     ORDER BY c.connected_at DESC, c.client_id`,
    [brokerId],
  );
}

/** Broker ids that have a connected-client roster (a log_file configured and parsed). */
export async function brokersWithClientRoster(): Promise<string[]> {
  const rows = await query<{ broker_id: string }>(`SELECT DISTINCT broker_id FROM mqtt_client`);
  return rows.map((r) => r.broker_id);
}

/** Broker ids observed in traffic recently, for filter dropdowns. */
export async function distinctBrokers(): Promise<string[]> {
  const rows = await query<{ source_broker_id: string }>(
    `SELECT DISTINCT source_broker_id FROM packets
     WHERE source_broker_id IS NOT NULL AND source_broker_id <> '' AND first_seen_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)
     LIMIT 50`,
  );
  return rows.map((r) => r.source_broker_id);
}

/** SSE tail: fetch live events with id greater than the cursor. Indexed PK range scan. */
export async function liveEventsSince(cursorId: number, limit = 200): Promise<{ id: number; created_at: string; event_type: string; payload: unknown }[]> {
  return query(
    `SELECT id, created_at, event_type, payload FROM live_events WHERE id > ? ORDER BY id ASC LIMIT ${Math.min(limit, 500)}`,
    [cursorId],
  );
}

export async function maxLiveEventId(): Promise<number> {
  const [row] = await query<{ m: number | null }>(`SELECT MAX(id) m FROM live_events`);
  return Number(row?.m ?? 0);
}

// ---------------------------------------------------------------------------
// Phase 2: nodes, biography, telemetry, matrix, map, traceroutes, analytics
// ---------------------------------------------------------------------------

export interface NodeRow {
  node_id: number;
  long_name: string | null;
  short_name: string | null;
  hw_model: string | null;
  role: string | null;
  is_gateway: number;
  is_relay: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_position_at: string | null;
  total_packet_count: number;
  total_reception_count: number;
  spoof_flag_count: number;
  has_position: number;
  hops: number | null;
}

export interface NodeFilter {
  q?: string; limit?: number; offset?: number; includeMuted?: boolean;
  broker?: string; channelId?: string;
  role?: string;                          // exact role match (CLIENT, ROUTER, ...)
  kind?: "gateway" | "relay" | "node";    // derived from is_gateway/is_relay
  hw?: string;                            // exact hw_model match
  hasPosition?: boolean;                  // has a real GPS fix in node_positions
  seenWithin?: "1h" | "24h" | "7d" | "30d"; // last_seen_at recency window
  hasKey?: boolean;                       // has a PKI public key on record
  spoof?: boolean;                        // has >=1 spoof flag
  sort?: "last_seen" | "first_seen" | "packets" | "receptions" | "name" | "hops";
}

// Whitelisted recency windows so seenWithin never reaches SQL as raw text.
const SEEN_WINDOW: Record<string, string> = { "1h": "1 HOUR", "24h": "24 HOUR", "7d": "7 DAY", "30d": "30 DAY" };
// Whitelisted sort orders (column + direction), never interpolated from user input directly.
const NODE_SORT: Record<string, string> = {
  last_seen: "n.last_seen_at DESC", first_seen: "n.first_seen_at DESC",
  packets: "n.total_packet_count DESC", receptions: "n.total_reception_count DESC",
  name: "n.long_name ASC",
  // Nearest first; nodes with no recent hop reading sort last rather than jumping to the top.
  hops: "h.hops IS NULL, h.hops ASC",
};

// Shared WHERE builder for listNodes/countNodes so the list and its total always agree.
// The node_positions LEFT JOIN is always present (has_position needs it); every clause is
// parameterised except the whitelisted recency window.
function buildNodeFilter(opts: NodeFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = [];
  const q = opts.q?.trim();
  if (q) {
    const bare = q.replace(/^!/, "");
    const like = `%${bare}%`;
    const idParts = ["n.long_name LIKE ?", "n.short_name LIKE ?", "LOWER(LPAD(HEX(n.node_id),8,'0')) LIKE ?"];
    params.push(like, like, `%${bare.toLowerCase()}%`);
    if (/^\d+$/.test(bare)) { idParts.push("n.node_id = ?"); params.push(Number(bare)); }
    clauses.push(`(${idParts.join(" OR ")})`);
  }
  if (opts.broker || opts.channelId) {
    const parts: string[] = [];
    if (opts.broker) { parts.push("pk.source_broker_id = ?"); params.push(opts.broker); }
    if (opts.channelId) { parts.push("pk.channel_id = ?"); params.push(opts.channelId); }
    clauses.push(`EXISTS (SELECT 1 FROM packets pk WHERE pk.from_node_id = n.node_id AND ${parts.join(" AND ")})`);
  }
  if (opts.role) { clauses.push("n.role = ?"); params.push(opts.role); }
  if (opts.hw) { clauses.push("n.hw_model = ?"); params.push(opts.hw); }
  if (opts.kind === "gateway") clauses.push("n.is_gateway = 1");
  else if (opts.kind === "relay") clauses.push("n.is_relay = 1");
  else if (opts.kind === "node") clauses.push("n.is_gateway = 0 AND n.is_relay = 0");
  if (opts.hasPosition === true) clauses.push("p.node_id IS NOT NULL");
  else if (opts.hasPosition === false) clauses.push("p.node_id IS NULL");
  if (opts.hasKey === true) clauses.push("n.public_key_hex IS NOT NULL AND n.public_key_hex <> ''");
  else if (opts.hasKey === false) clauses.push("(n.public_key_hex IS NULL OR n.public_key_hex = '')");
  if (opts.spoof) clauses.push("n.spoof_flag_count > 0");
  const win = opts.seenWithin && SEEN_WINDOW[opts.seenWithin];
  if (win) clauses.push(`n.last_seen_at >= (UTC_TIMESTAMP() - INTERVAL ${win})`);
  if (!opts.includeMuted) clauses.push("n.mute_hidden = 0");
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  return { where, params };
}

export async function listNodes(opts: NodeFilter = {}): Promise<NodeRow[]> {
  const limit = clampLimit(opts.limit ?? 200, 2000);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const { where, params } = buildNodeFilter(opts);
  const order = NODE_SORT[opts.sort ?? "last_seen"] ?? NODE_SORT.last_seen;
  // hops = fewest hops any gateway used to hear this node in the last 24h (0 = direct heard),
  // from the hourly rollup + raw tail; scoped to the selected broker's vantage when one is set,
  // matching the header stats. The join's placeholders precede the WHERE params in the SQL text.
  const tail = await hopsTailStart();
  return query<NodeRow>(
    `SELECT n.node_id, n.long_name, n.short_name, n.hw_model, n.role, n.is_gateway, n.is_relay,
            n.first_seen_at, n.last_seen_at, n.last_position_at,
            n.total_packet_count, n.total_reception_count, n.spoof_flag_count,
            (p.node_id IS NOT NULL) AS has_position, h.hops AS hops
     FROM nodes n
       LEFT JOIN node_positions p ON p.node_id = n.node_id
       LEFT JOIN ${hopsAggregateSql(!!opts.broker)} h ON h.from_node_id = n.node_id
     ${where}
     ORDER BY ${order}
     LIMIT ${limit} OFFSET ${offset}`,
    [...hopsParams(opts.broker, tail), ...params],
  );
}

/** Total matching rows for the same filter, so the page can paginate honestly. */
export async function countNodes(opts: NodeFilter = {}): Promise<number> {
  const { where, params } = buildNodeFilter(opts);
  const [row] = await query<{ c: number }>(
    `SELECT COUNT(*) c FROM nodes n LEFT JOIN node_positions p ON p.node_id = n.node_id ${where}`,
    params,
  );
  return Number(row?.c ?? 0);
}

/**
 * Activity summary for the nodes-page header. One round trip. Scoped to the broker/channel
 * segment when given, so the header reflects the selected broker (nodes that transmitted on
 * that broker/channel), matching how listNodes/countNodes membership-filter.
 */
export async function nodeStats(scope: { broker?: string; channelId?: string } = {}): Promise<{ total: number; active1h: number; active12h: number; active24h: number; active7d: number; active30d: number; withPosition: number; gateways: number }> {
  const params: unknown[] = [];
  const clauses = ["n.mute_hidden = 0"];
  if (scope.broker || scope.channelId) {
    const parts: string[] = [];
    if (scope.broker) { parts.push("pk.source_broker_id = ?"); params.push(scope.broker); }
    if (scope.channelId) { parts.push("pk.channel_id = ?"); params.push(scope.channelId); }
    clauses.push(`EXISTS (SELECT 1 FROM packets pk WHERE pk.from_node_id = n.node_id AND ${parts.join(" AND ")})`);
  }
  const [row] = await query<{ total: number; a1: number; a12: number; a24: number; a7: number; a30: number; pos: number; gw: number }>(
    `SELECT COUNT(*) total,
            SUM(n.last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 1 HOUR)) a1,
            SUM(n.last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 12 HOUR)) a12,
            SUM(n.last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)) a24,
            SUM(n.last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)) a7,
            SUM(n.last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY)) a30,
            SUM(p.node_id IS NOT NULL) pos,
            SUM(n.is_gateway = 1) gw
     FROM nodes n LEFT JOIN node_positions p ON p.node_id = n.node_id
     WHERE ${clauses.join(" AND ")}`,
    params,
  );
  return {
    total: Number(row?.total ?? 0), active1h: Number(row?.a1 ?? 0), active12h: Number(row?.a12 ?? 0),
    active24h: Number(row?.a24 ?? 0), active7d: Number(row?.a7 ?? 0),
    active30d: Number(row?.a30 ?? 0), withPosition: Number(row?.pos ?? 0), gateways: Number(row?.gw ?? 0),
  };
}

/** Distinct non-null roles present on visible nodes, for the role filter dropdown. */
export async function distinctNodeRoles(): Promise<string[]> {
  const rows = await query<{ role: string }>(
    `SELECT DISTINCT role FROM nodes WHERE role IS NOT NULL AND role <> '' AND mute_hidden = 0 ORDER BY role`,
  );
  return rows.map((r) => r.role);
}

/** Distinct non-null hardware models present on visible nodes, for the hardware filter dropdown. */
export async function distinctNodeHardware(): Promise<string[]> {
  const rows = await query<{ hw_model: string }>(
    `SELECT DISTINCT hw_model FROM nodes WHERE hw_model IS NOT NULL AND hw_model <> '' AND mute_hidden = 0 ORDER BY hw_model LIMIT 200`,
  );
  return rows.map((r) => r.hw_model);
}

type NodeDetail = NodeRow & {
  latitude: number | null; longitude: number | null; altitude_m: number | null; precision_bits: number | null;
  public_key_hex: string | null; firmware_version: string | null; is_licensed: number | null;
  // Provenance so no consumer mistakes an estimate for GPS. 'estimated' means latitude/
  // longitude above are NULL and est_latitude/est_longitude carry the inferred position.
  position_source: "gps" | "estimated" | null;
  est_latitude: number | null; est_longitude: number | null;
  confidence_radius_m: number | null; method_tier: number | null;
  possibly_mobile: number | null; estimate_computed_at: string | null;
  mute_hidden: number; position_ignored: number; // admin ignore controls (from nodes.*)
  rf_height_m: number | null; rf_eirp_dbm: number | null; // per-node RF profile overrides
};

// Name + role only, no coordinates: for headers on node sub-pages that must not touch position (so
// they stay clear of the fuzz-policy guard). Use getNode when you actually need position/telemetry.
export async function getNodeHeader(nodeId: number): Promise<{ long_name: string | null; short_name: string | null; role: string | null } | null> {
  const rows = await query<{ long_name: string | null; short_name: string | null; role: string | null }>(
    `SELECT long_name, short_name, role FROM nodes WHERE node_id = ? LIMIT 1`, [nodeId]);
  return rows[0] ?? null;
}

export async function getNode(nodeId: number): Promise<NodeDetail | null> {
  const rows = await query<NodeDetail>(
    `SELECT n.*, p.latitude, p.longitude, p.altitude_m, p.precision_bits,
            (p.node_id IS NOT NULL) AS has_position,
            CASE WHEN p.latitude IS NOT NULL THEN 'gps'
                 WHEN e.node_id IS NOT NULL THEN 'estimated'
                 ELSE NULL END AS position_source,
            e.latitude AS est_latitude, e.longitude AS est_longitude,
            e.confidence_radius_m, e.method_tier, e.possibly_mobile,
            e.computed_at AS estimate_computed_at
     FROM nodes n
     LEFT JOIN node_positions p ON p.node_id = n.node_id
     LEFT JOIN ${LATEST_ESTIMATE} e ON e.node_id = n.node_id
     WHERE n.node_id = ?`,
    [nodeId],
  );
  return rows[0] ?? null;
}

export interface BiographyItem {
  kind: "identity" | "flag" | "position";
  at: string;
  title: string;
  detail: string | null;
  severity?: string;
}

export async function getNodeBiography(nodeId: number): Promise<{
  identity: { event_type: string; old_value: string | null; new_value: string | null; observed_at: string }[];
  flags: { flag_type: string; severity: string; message: string; created_at: string; acknowledged_at: string | null }[];
  positions: { latitude: number; longitude: number; altitude_m: number | null; observed_at: string }[];
  gatewaysHeardBy: { gateway_id: number; status: string; last_direct_at: string | null; last_relayed_at: string | null }[];
}> {
  const [identity, flags, positions, gatewaysHeardBy] = await Promise.all([
    query<{ event_type: string; old_value: string | null; new_value: string | null; observed_at: string }>(
      `SELECT event_type, old_value, new_value, observed_at FROM node_identity_events
       WHERE node_id=? ORDER BY observed_at DESC LIMIT 200`,
      [nodeId],
    ),
    query<{ flag_type: string; severity: string; message: string; created_at: string; acknowledged_at: string | null }>(
      `SELECT flag_type, severity, message, created_at, acknowledged_at FROM node_flags
       WHERE node_id=? ORDER BY created_at DESC LIMIT 100`,
      [nodeId],
    ),
    query<{ latitude: number; longitude: number; altitude_m: number | null; observed_at: string }>(
      `SELECT latitude, longitude, altitude_m, observed_at FROM node_position_events
       WHERE node_id=? ORDER BY observed_at DESC LIMIT 500`,
      [nodeId],
    ),
    query<{ gateway_id: number; status: string; last_direct_at: string | null; last_relayed_at: string | null }>(
      `SELECT gateway_id, status, last_direct_at, last_relayed_at FROM gateway_node_link
       WHERE node_id=? ORDER BY (status='direct') DESC, last_direct_at DESC LIMIT 100`,
      [nodeId],
    ),
  ]);
  return { identity, flags, positions, gatewaysHeardBy };
}

export interface TelemetryPoint { t: string; v: number }

export async function getNodeTelemetry(nodeId: number, metric: string, hours = 168): Promise<TelemetryPoint[]> {
  // Downsample: raw for <=48h, hourly average beyond that (keeps charts responsive).
  // Clamp to [now - window, now] so a stray future-dated reading (node with a bad RTC)
  // cannot stretch the chart axis out by years.
  if (hours <= 48) {
    return query<TelemetryPoint>(
      `SELECT observed_at AS t, value AS v FROM node_telemetry
       WHERE node_id=? AND metric=? AND observed_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND observed_at <= UTC_TIMESTAMP()
       ORDER BY observed_at ASC LIMIT 5000`,
      [nodeId, metric, hours],
    );
  }
  return query<TelemetryPoint>(
    `SELECT DATE_FORMAT(observed_at, '%Y-%m-%d %H:00:00') AS t, AVG(value) AS v
     FROM node_telemetry
     WHERE node_id=? AND metric=? AND observed_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND observed_at <= UTC_TIMESTAMP()
     GROUP BY 1 ORDER BY 1 ASC LIMIT 5000`,
    [nodeId, metric, hours],
  );
}

export interface LatestMetric { metric: string; value: number; observed_at: string }

/** Latest value of every telemetry metric a node has reported (last 30 days), for the node
 * page's full-telemetry grid. Bounded so partition pruning keeps it cheap. */
export async function nodeLatestMetrics(nodeId: number): Promise<LatestMetric[]> {
  return query<LatestMetric>(
    `SELECT t.metric, t.value, t.observed_at
     FROM node_telemetry t
     JOIN (SELECT metric, MAX(observed_at) mo FROM node_telemetry
           WHERE node_id=? AND observed_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY)
           GROUP BY metric) x
       ON x.metric=t.metric AND x.mo=t.observed_at
     WHERE t.node_id=? AND t.observed_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY)
     ORDER BY t.metric`,
    [nodeId, nodeId],
  );
}

export async function nodeTelemetryMetrics(nodeId: number): Promise<string[]> {
  const rows = await query<{ metric: string }>(
    `SELECT DISTINCT metric FROM node_telemetry WHERE node_id=? ORDER BY metric`,
    [nodeId],
  );
  return rows.map((r) => r.metric);
}

export interface MatrixCell { gateway_id: number; node_id: number; status: string; last_direct_at: string | null; last_relayed_at: string | null; direct_count: number }

export async function getMatrix(nodeLimit = 60): Promise<{ gateways: number[]; nodes: NodeRow[]; cells: MatrixCell[] }> {
  const gws = await query<{ gateway_id: number }>(`SELECT gateway_id FROM gateways WHERE active=1 ORDER BY gateway_id`);
  const gateways = gws.map((g) => g.gateway_id);
  // Cap to the most recently active nodes so the grid stays legible at 2000-node scale.
  const nodes = await query<NodeRow>(
    `SELECT n.node_id, n.long_name, n.short_name, n.hw_model, n.role, n.is_gateway, n.is_relay,
            n.first_seen_at, n.last_seen_at, n.last_position_at,
            n.total_packet_count, n.total_reception_count, n.spoof_flag_count, 0 AS has_position
     FROM nodes n WHERE n.last_seen_at IS NOT NULL
     ORDER BY n.last_seen_at DESC LIMIT ${clampLimit(nodeLimit, 200)}`,
  );
  const nodeIds = nodes.map((n) => n.node_id);
  let cells: MatrixCell[] = [];
  if (nodeIds.length && gateways.length) {
    cells = await query<MatrixCell>(
      `SELECT gateway_id, node_id, status, last_direct_at, last_relayed_at, direct_count
       FROM gateway_node_link WHERE node_id IN (${nodeIds.join(",")})`,
    );
  }
  return { gateways, nodes, cells };
}

export interface MapNode {
  node_id: number; long_name: string | null; short_name: string | null; role: string | null;
  hw_model: string | null; firmware_version: string | null; is_gateway: number; is_relay: number;
  latitude: number; longitude: number; altitude_m: number | null;
  last_seen_at: string | null; hops: number | null; direct_gateways: number; best_rssi: number | null;
  total_packet_count: number; total_reception_count: number;
  battery: number | null; voltage: number | null; chan_util: number | null;
  // Provenance: 'gps' = real transmitted position, 'estimated' = inferred (see getEstimatedMapNodes).
  position_source: "gps" | "estimated";
  confidence_radius_m: number | null; method_tier: number | null; est_receiver_count: number | null;
  possibly_mobile: number | null; estimate_computed_at: string | null;
  heard_by?: HeardEntry[]; // gateways (and their brokers) that heard this node, for hovers
}
export interface MapLink { gateway_id: number; node_id: number; status: string; last_rssi: number | null; last_snr: number | null }

// One gateway that heard a node, with the broker it reported through. Used by map hovers.
export interface HeardEntry { gateway_id: number; name: string | null; broker: string | null; status: string; rssi: number | null }

// node_id -> gateways heard from (direct first, then by RSSI, capped) for map hover cards.
// When a broker is selected, only gateways reporting through that broker are listed, matching
// the broker-scoped hop/direct-gateway counts on the same hover.
export async function heardByMap(broker?: string): Promise<Map<number, HeardEntry[]>> {
  // The per-node cap is applied in SQL, not after the fact. This used to select EVERY recently
  // active (gateway, node) pair with no LIMIT and then keep the top 8 per node in JS: on a regional
  // mesh with 3,000 nodes and 30 gateways that is up to ~90,000 rows pulled into Node and 99% of
  // them discarded, on every /api/v1/livemap call and every server render of /map and /coverage.
  const rows = await query<{ node_id: number; gateway_id: number; status: string; last_rssi: number | null; broker_id: string | null; long_name: string | null; short_name: string | null }>(
    `SELECT node_id, gateway_id, status, last_rssi, broker_id, long_name, short_name FROM (
       SELECT l.node_id, l.gateway_id, l.status, l.last_rssi, gw.broker_id, gn.long_name, gn.short_name,
              ROW_NUMBER() OVER (
                PARTITION BY l.node_id
                -- Same order the JS applied: direct before relayed, then strongest first, with
                -- unknown RSSI last (MySQL sorts NULL first under DESC, hence the explicit test).
                ORDER BY (l.status = 'direct') DESC, l.last_rssi IS NULL, l.last_rssi DESC
              ) AS rn
       FROM gateway_node_link l
       JOIN gateways gw ON gw.gateway_id = l.gateway_id
       LEFT JOIN nodes gn ON gn.node_id = l.gateway_id
       WHERE l.status IN ('direct','relayed')
         AND (l.last_direct_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY) OR l.last_relayed_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY))${broker ? " AND gw.broker_id = ?" : ""}
     ) ranked WHERE rn <= 8
     ORDER BY node_id, rn`,
    broker ? [broker] : [],
  );
  const map = new Map<number, HeardEntry[]>();
  for (const r of rows) {
    let arr = map.get(r.node_id);
    if (!arr) { arr = []; map.set(r.node_id, arr); }
    arr.push({ gateway_id: r.gateway_id, name: r.long_name ?? r.short_name ?? null, broker: r.broker_id, status: r.status, rssi: r.last_rssi });
  }
  return map;
}

export interface MapFilter { broker?: string; channelId?: string }

// Audit P3: the "fewest hops in 24h" statistic for /map and /livemap is served from the
// hourly rollup (folded within ~60s of each completed hour) plus a raw-receptions tail
// covering only the not-yet-folded hours, instead of re-aggregating 24h of raw receptions
// on every render. Broker scoping joins gateways for the rollup branch (a gateway reports
// through one broker) and uses source_broker_id for the raw tail, matching heardByMap.
// Placeholder order: [broker?], tailStart, [broker?].
function hopsAggregateSql(broker: boolean): string {
  return `(
    SELECT from_node_id, MIN(hops) AS hops FROM (
      SELECT rr.node_id AS from_node_id, MIN(rr.hops_min) AS hops
      FROM reception_rollup_hour rr${broker ? " JOIN gateways gwh ON gwh.gateway_id = rr.gateway_id" : ""}
      WHERE rr.bucket_start >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR) AND rr.hops_min IS NOT NULL${broker ? " AND gwh.broker_id = ?" : ""}
      GROUP BY rr.node_id
      UNION ALL
      SELECT r.from_node_id, MIN(CAST(r.hop_start AS SIGNED) - CAST(r.hop_limit AS SIGNED)) AS hops
      FROM receptions r
      WHERE r.rx_time >= ? AND r.hop_start IS NOT NULL AND r.hop_limit IS NOT NULL
        AND r.reception_class IN ('rf_direct','rf_relayed')
        AND CAST(r.hop_start AS SIGNED) - CAST(r.hop_limit AS SIGNED) BETWEEN 0 AND 255${broker ? " AND r.source_broker_id = ?" : ""}
      GROUP BY r.from_node_id
    ) u GROUP BY from_node_id
  )`;
}

// Where the raw-receptions tail starts: the first hour not yet folded into the rollup,
// clamped to the 24h map window. Normally the current (incomplete) hour; the full 24h only
// on a fresh install (nothing folded yet) or when the worker is far behind.
async function hopsTailStart(): Promise<string> {
  const rows = await query<{ wm: string | null }>(
    `SELECT last_bucket_folded AS wm FROM rollup_watermark WHERE rollup_name='hourly'`,
  );
  const dayAgo = new Date(Date.now() - 24 * 3_600_000);
  const wm = rows[0]?.wm ? new Date(rows[0].wm + "Z") : null;
  const start = wm ? new Date(wm.getTime() + 3_600_000) : dayAgo;
  return toMysqlUtc(start > dayAgo ? start : dayAgo);
}

// Bind parameters for hopsAggregateSql, in placeholder order.
function hopsParams(broker: string | undefined, tail: string): unknown[] {
  return broker ? [broker, tail, broker] : [tail];
}

// EXISTS clause restricting to nodes that transmitted at least one packet on the given
// broker/channel. Empty when no filter is set. Alias is the nodes table alias (n).
/** How far back the broker/channel membership filter looks. Matches heardByMap's window, so a node
 * shown as heard by a broker's gateways is a node the same filter admits. */
const MEMBERSHIP_DAYS = 30;

/**
 * "This node has been seen on this broker / channel", as a correlated EXISTS over `packets`.
 *
 * The time bound is not cosmetic. `packets` is partitioned by first_seen_at, and neither
 * source_broker_id nor channel_id is indexed, so without a first_seen_at predicate MySQL can prune
 * no partitions: for every candidate node it range-scanned ix_from_time across all ~90 daily
 * partitions and filtered the broker/channel out by hand. The bound both prunes partitions and
 * makes the filter mean something defensible ("recently", not "ever").
 */
function packetMembership(f: MapFilter): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (f.broker) { parts.push("pk.source_broker_id = ?"); params.push(f.broker); }
  if (f.channelId) { parts.push("pk.channel_id = ?"); params.push(f.channelId); }
  if (parts.length === 0) return { sql: "", params: [] };
  return {
    sql: ` AND EXISTS (SELECT 1 FROM packets pk WHERE pk.from_node_id = n.node_id
             AND pk.first_seen_at >= (UTC_TIMESTAMP() - INTERVAL ${MEMBERSHIP_DAYS} DAY)
             AND ${parts.join(" AND ")})`,
    params,
  };
}

export async function getMapData(filter: MapFilter = {}): Promise<{ nodes: MapNode[]; links: MapLink[] }> {
  const m = packetMembership(filter);
  // hops = fewest hops any gateway used to hear this node in the last 24h (0 = direct heard),
  // served from the hourly rollup + raw tail (hopsAggregateSql). When a broker is selected,
  // scope hops to that broker's receptions so the count reflects that broker's vantage
  // (a node direct to a Chicago gateway may be several hops via NWI).
  const tail = await hopsTailStart();
  const hp = hopsParams(filter.broker, tail);
  // Scope direct-gateway count, best RSSI, and the "heard by" list to the selected broker's
  // gateways too (not just hops), so a node's whole hover reflects that broker's vantage.
  const gwBroker = filter.broker ? " AND gw.broker_id = ?" : "";
  const bp: unknown[] = filter.broker ? [filter.broker] : [];
  const nodes = await query<MapNode>(
    `SELECT n.node_id, n.long_name, n.short_name, n.role, n.hw_model, n.firmware_version,
            n.is_gateway, n.is_relay, p.latitude, p.longitude, p.altitude_m, n.last_seen_at,
            n.total_packet_count, n.total_reception_count,
            h.hops,
            (SELECT COUNT(*) FROM gateway_node_link g JOIN gateways gw ON gw.gateway_id=g.gateway_id WHERE g.node_id=n.node_id AND g.direct_count>0${gwBroker}) AS direct_gateways,
            (SELECT MAX(g.last_rssi) FROM gateway_node_link g JOIN gateways gw ON gw.gateway_id=g.gateway_id WHERE g.node_id=n.node_id AND g.direct_count>0${gwBroker}) AS best_rssi,
            tm.battery, tm.voltage, tm.chan_util,
            'gps' AS position_source,
            NULL AS confidence_radius_m, NULL AS method_tier, NULL AS est_receiver_count,
            NULL AS possibly_mobile, NULL AS estimate_computed_at
     FROM node_positions p
     JOIN nodes n ON n.node_id = p.node_id
     LEFT JOIN ${hopsAggregateSql(!!filter.broker)} h ON h.from_node_id = n.node_id
     LEFT JOIN (
       SELECT node_id,
              MAX(CASE WHEN metric='battery_pct' THEN value END) AS battery,
              MAX(CASE WHEN metric='voltage' THEN value END) AS voltage,
              MAX(CASE WHEN metric='chan_util' THEN value END) AS chan_util
       FROM node_telemetry
       WHERE observed_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)
       GROUP BY node_id
     ) tm ON tm.node_id = n.node_id
     WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL AND (n.position_ignored = 0 OR n.position_ignored IS NULL)${m.sql}`,
    // Param order follows SQL text: direct_gateways subquery, best_rssi subquery, hop join, then membership.
    [...bp, ...bp, ...hp, ...m.params],
  );
  const positioned = new Set(nodes.map((n) => n.node_id));
  // RF links only between endpoints we can place on the map.
  const allLinks = await query<MapLink>(
    `SELECT gateway_id, node_id, status, last_rssi, last_snr FROM gateway_node_link
     WHERE status IN ('direct','relayed')
       AND (last_direct_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY) OR last_relayed_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY))`,
  );
  const links = allLinks.filter((l) => positioned.has(l.gateway_id) && positioned.has(l.node_id));
  // Neighbor links: node-to-node adjacency reported via NeighborInfo (distinct from the
  // gateway-heard direct/relayed links above). Represented with status 'neighbor'; endpoints
  // go in the gateway_id/node_id fields so the map's shared position lookup places them.
  const neighborRows = await query<{ a: number; b: number }>(
    `SELECT node_id AS a, neighbor_id AS b FROM node_neighbor`,
  );
  const seenPair = new Set<string>();
  for (const r of neighborRows) {
    if (!positioned.has(r.a) || !positioned.has(r.b) || r.a === r.b) continue;
    const key = r.a < r.b ? `${r.a}-${r.b}` : `${r.b}-${r.a}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    links.push({ gateway_id: r.a, node_id: r.b, status: "neighbor", last_rssi: null, last_snr: null });
  }
  const hb = await heardByMap(filter.broker);
  for (const n of nodes) n.heard_by = hb.get(n.node_id) ?? [];
  return { nodes, links };
}

export interface HistoryNode {
  node_id: number; long_name: string | null; short_name: string | null; role: string | null;
  is_gateway: number; latitude: number; longitude: number; altitude_m: number | null; hops: number | null;
}

/**
 * The map's state as of an instant: nodes that transmitted within [at-windowMin, at] shown
 * at the position they had last reported at or before `at`. Powers the history time-slider.
 * Uses node_position_events (as-of position) + receptions (activity in the window).
 */
export async function getMapAt(at: Date, windowMin: number): Promise<HistoryNode[]> {
  const end = toMysqlUtc(at);
  const start = toMysqlUtc(new Date(at.getTime() - Math.min(1440, Math.max(1, windowMin)) * 60000));
  return query<HistoryNode>(
    `WITH active AS (
       -- Activity counts any reception class (a node uplinking its own MQTT is still active),
       -- but hops are attributed only from RF receptions; mqtt_self/injected copies carry hop
       -- fields that would otherwise show a non-RF node as 0-hop direct-heard (Rule 4).
       SELECT from_node_id AS node_id,
              MIN(CASE WHEN reception_class IN ('rf_direct','rf_relayed')
                        AND hop_start IS NOT NULL AND hop_limit IS NOT NULL
                       THEN hop_start - hop_limit END) AS hops
       FROM receptions
       WHERE rx_time > ? AND rx_time <= ?
       GROUP BY from_node_id
     ),
     pos AS (
       SELECT node_id, latitude, longitude, altitude_m,
              ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY observed_at DESC) rn
       FROM node_position_events
       WHERE observed_at <= ? AND node_id IN (SELECT node_id FROM active)
     )
     SELECT a.node_id, a.hops, n.long_name, n.short_name, n.role, n.is_gateway,
            p.latitude, p.longitude, p.altitude_m
     FROM active a
     JOIN pos p ON p.node_id = a.node_id AND p.rn = 1
     JOIN nodes n ON n.node_id = a.node_id
     WHERE (n.position_ignored = 0 OR n.position_ignored IS NULL)
     LIMIT 3000`,
    [start, end, end],
  );
}

// Latest position_estimate row per node (history table keeps all recomputes).
const LATEST_ESTIMATE = `(
  SELECT pe.* FROM position_estimate pe
  JOIN (SELECT node_id, MAX(computed_at) AS mc FROM position_estimate GROUP BY node_id) x
    ON x.node_id = pe.node_id AND x.mc = pe.computed_at
)`;

// Estimated-position nodes for the map, shaped like MapNode with position_source='estimated'.
// A node that has a real position is excluded (a real fix supersedes the estimate).
export async function getEstimatedMapNodes(filter: MapFilter = {}): Promise<MapNode[]> {
  const m = packetMembership(filter);
  const nodes = await query<MapNode>(
    `SELECT n.node_id, n.long_name, n.short_name, n.role, n.hw_model, n.firmware_version,
            n.is_gateway, n.is_relay, e.latitude, e.longitude, NULL AS altitude_m, n.last_seen_at,
            NULL AS hops,
            (SELECT COUNT(*) FROM gateway_node_link g WHERE g.node_id=n.node_id AND g.direct_count>0) AS direct_gateways,
            (SELECT MAX(g.last_rssi) FROM gateway_node_link g WHERE g.node_id=n.node_id AND g.direct_count>0) AS best_rssi,
            n.total_packet_count, n.total_reception_count,
            NULL AS battery, NULL AS voltage, NULL AS chan_util,
            'estimated' AS position_source,
            e.confidence_radius_m, e.method_tier, e.receiver_count AS est_receiver_count,
            e.possibly_mobile, e.computed_at AS estimate_computed_at
     FROM ${LATEST_ESTIMATE} e
     JOIN nodes n ON n.node_id = e.node_id
     LEFT JOIN node_positions np ON np.node_id = e.node_id AND np.latitude IS NOT NULL AND np.longitude IS NOT NULL
     WHERE np.node_id IS NULL AND (n.mute_hidden = 0 OR n.mute_hidden IS NULL)
       AND (n.position_ignored = 0 OR n.position_ignored IS NULL)${m.sql}`,
    m.params,
  );
  // Broker-scoped, like getMapData's call: an unfiltered heard_by made the map's broker control
  // only half apply to estimated markers.
  const hb = await heardByMap(filter.broker);
  for (const n of nodes) n.heard_by = hb.get(n.node_id) ?? [];
  return nodes;
}

export interface EstimatedNode {
  node_id: number; long_name: string | null; short_name: string | null; role: string | null;
  latitude: number; longitude: number; confidence_radius_m: number; method_tier: number;
  receiver_count: number; possibly_mobile: number; computed_at: string;
}

export interface LiveMapNode {
  node_id: number; long_name: string | null; short_name: string | null; role: string | null;
  is_gateway: number; is_relay: number; hw_model: string | null; firmware_version: string | null;
  latitude: number; longitude: number; last_seen_at: string | null;
  hops: number | null; direct_gateways: number; best_rssi: number | null;
  heard_by?: HeardEntry[];
}

export interface LiveMapData {
  nodes: LiveMapNode[];
  inferred: { a: number; b: number }[];
  brokers: string[];
  estimates: EstimatedNode[];
}

// Latest estimate per node lacking a real position, shaped for the live/coverage maps.
export async function getEstimatedNodes(): Promise<EstimatedNode[]> {
  return query<EstimatedNode>(
    `SELECT n.node_id, n.long_name, n.short_name, n.role,
            e.latitude, e.longitude, e.confidence_radius_m, e.method_tier,
            e.receiver_count, e.possibly_mobile, e.computed_at
     FROM ${LATEST_ESTIMATE} e
     JOIN nodes n ON n.node_id = e.node_id
     LEFT JOIN node_positions np ON np.node_id = e.node_id AND np.latitude IS NOT NULL AND np.longitude IS NOT NULL
     WHERE np.node_id IS NULL AND (n.mute_hidden = 0 OR n.mute_hidden IS NULL)
       AND (n.position_ignored = 0 OR n.position_ignored IS NULL)`,
  );
}

// Positions to seed the live-map cache, plus inferred RF topology (NeighborInfo links
// among positioned nodes within the inference window) drawn as a dashed underlay.
export async function getLiveMapData(hours = 24, broker?: string): Promise<LiveMapData> {
  // Scope hops to the selected broker's receptions (matches /map), so hop distance reflects
  // that broker's vantage rather than the global minimum across all gateways. Hops come from
  // the hourly rollup + raw tail (hopsAggregateSql, audit P3).
  const tail = await hopsTailStart();
  const hp = hopsParams(broker, tail);
  const gwBroker = broker ? " AND gw.broker_id = ?" : "";
  const bp: unknown[] = broker ? [broker] : [];
  const nodes = await query<LiveMapNode>(
    `SELECT n.node_id, n.long_name, n.short_name, n.role, n.is_gateway, n.is_relay,
            n.hw_model, n.firmware_version, p.latitude, p.longitude, n.last_seen_at,
            h.hops,
            (SELECT COUNT(*) FROM gateway_node_link g JOIN gateways gw ON gw.gateway_id=g.gateway_id WHERE g.node_id=n.node_id AND g.direct_count>0${gwBroker}) AS direct_gateways,
            (SELECT MAX(g.last_rssi) FROM gateway_node_link g JOIN gateways gw ON gw.gateway_id=g.gateway_id WHERE g.node_id=n.node_id AND g.direct_count>0${gwBroker}) AS best_rssi
     FROM node_positions p JOIN nodes n ON n.node_id = p.node_id
     LEFT JOIN ${hopsAggregateSql(!!broker)} h ON h.from_node_id = n.node_id
     WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL AND (n.position_ignored = 0 OR n.position_ignored IS NULL)`,
    // Param order follows SQL text: direct_gateways, best_rssi, then the hop join.
    [...bp, ...bp, ...hp],
  );
  const positioned = new Set(nodes.map((n) => n.node_id));
  const nbr = await query<{ a: number; b: number }>(
    `SELECT node_id AS a, neighbor_id AS b FROM node_neighbor
     WHERE updated_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) LIMIT 4000`,
    [clampLimit(hours, 24 * 30, 24)],
  );
  const seen = new Set<string>();
  const inferred: { a: number; b: number }[] = [];
  for (const e of nbr) {
    if (!positioned.has(e.a) || !positioned.has(e.b) || e.a === e.b) continue;
    const [lo, hi] = e.a < e.b ? [e.a, e.b] : [e.b, e.a];
    const k = `${lo}-${hi}`;
    if (seen.has(k)) continue;
    seen.add(k);
    inferred.push({ a: lo, b: hi });
  }
  const brokers = await distinctBrokers();
  const estimates = await getEstimatedNodes();
  const hb = await heardByMap(broker);
  for (const n of nodes) n.heard_by = hb.get(n.node_id) ?? [];
  return { nodes, inferred, brokers, estimates };
}

export interface TracerouteRow {
  id: number;
  from_node_id: number;
  to_node_id: number;
  observed_at: string;
  hop_count: number | null;
  route: number[] | null;
  from_name: string | null;
}

export interface BridgeLogRow {
  id: number; bridged_at: string; direction: "out" | "in"; from_broker: string | null; to_broker: string | null;
  from_node_id: number | null; mesh_packet_id: number | null; channel_id: string | null; topic: string | null; dest_topic: string | null;
}

/** Recent MQTT-bridge forwards, for the bridge admin page. */
export async function listBridgeLog(limit = 100): Promise<BridgeLogRow[]> {
  return query<BridgeLogRow>(
    `SELECT id, bridged_at, direction, from_broker, to_broker, from_node_id, mesh_packet_id, channel_id, topic, dest_topic
     FROM bridge_log ORDER BY bridged_at DESC LIMIT ${clampLimit(limit, 500)}`,
  );
}

export interface FlagRow {
  flag_id: number; node_id: number; name: string | null; short_name: string | null; flag_type: string; severity: string;
  message: string; created_at: string; resolved_at: string | null; acknowledged_at: string | null;
}

/** Recent integrity flags across the mesh (spoof, identity flap, role violation, anomaly),
 * open/unacknowledged first. */
export async function recentFlags(limit = 200): Promise<FlagRow[]> {
  return query<FlagRow>(
    `SELECT f.flag_id, f.node_id, COALESCE(n.long_name, n.short_name) AS name, n.short_name AS short_name,
            f.flag_type, f.severity, f.message, f.created_at, f.resolved_at, f.acknowledged_at
     FROM node_flags f LEFT JOIN nodes n ON n.node_id = f.node_id
     ORDER BY (f.resolved_at IS NULL AND f.acknowledged_at IS NULL) DESC, f.created_at DESC
     LIMIT ${clampLimit(limit, 1000)}`,
  );
}

// --- Stats page aggregates ---

export interface StatsTotals { nodes_seen: number; heard_24h: number; heard_7d: number; packets_24h: number; packets_7d: number; gateways: number }

export async function statsTotals(): Promise<StatsTotals> {
  const [seen] = await query<{ c: number }>(`SELECT COUNT(*) c FROM nodes`);
  const [h24] = await query<{ c: number }>(`SELECT COUNT(*) c FROM nodes WHERE last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`);
  const [h7] = await query<{ c: number }>(`SELECT COUNT(*) c FROM nodes WHERE last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)`);
  const [p24] = await query<{ p: number }>(`SELECT COALESCE(SUM(total_packets),0) p FROM mesh_rollup_hour WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`);
  const [p7] = await query<{ p: number }>(`SELECT COALESCE(SUM(total_packets),0) p FROM mesh_rollup_hour WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)`);
  const [gw] = await query<{ c: number }>(`SELECT COUNT(*) c FROM gateways WHERE active=1`);
  return {
    nodes_seen: Number(seen?.c ?? 0), heard_24h: Number(h24?.c ?? 0), heard_7d: Number(h7?.c ?? 0),
    packets_24h: Number(p24?.p ?? 0), packets_7d: Number(p7?.p ?? 0), gateways: Number(gw?.c ?? 0),
  };
}

/** Total packets per day (mesh_rollup_day is not populated, so aggregate the hourly rollup). */
export async function packetsByDay(days = 30): Promise<{ day: string; packets: number }[]> {
  return query<{ day: string; packets: number }>(
    `SELECT DATE(bucket_start) AS day, SUM(total_packets) AS packets
     FROM mesh_rollup_hour WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     GROUP BY day ORDER BY day ASC`,
    [days],
  );
}

/** Packet types (by application port) over a window. */
export async function packetTypes(hours = 168): Promise<{ port_num: number; c: number }[]> {
  return query<{ port_num: number; c: number }>(
    `SELECT COALESCE(port_num, 0) AS port_num, COUNT(*) AS c FROM packets
     WHERE first_seen_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
     GROUP BY port_num ORDER BY c DESC LIMIT 24`,
    [hours],
  );
}

/** Packets per hour split by application port, last N hours, for a stacked traffic chart. */
export async function trafficByHourCategory(hours = 24): Promise<{ bucket: string; port_num: number; c: number }[]> {
  return query<{ bucket: string; port_num: number; c: number }>(
    `SELECT DATE_FORMAT(first_seen_at, '%Y-%m-%d %H:00:00') AS bucket, COALESCE(port_num, 0) AS port_num, COUNT(*) AS c
     FROM packets WHERE first_seen_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
     GROUP BY bucket, port_num ORDER BY bucket ASC`,
    [hours],
  );
}

/** How often a node broadcasts NodeInfo (port 4) over a window. */
export async function nodeAdvertisements(nodeId: number, days = 7): Promise<number> {
  const [r] = await query<{ c: number }>(
    `SELECT COUNT(*) c FROM packets
     WHERE from_node_id = ? AND port_num = 4 AND first_seen_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)`,
    [nodeId, days],
  );
  return Number(r?.c ?? 0);
}

export interface BusiestLink { gateway_id: number; node_id: number; gw_name: string | null; node_name: string | null; receptions: number }

/** Busiest RF links by total receptions (gateway hears node). */
export async function busiestLinks(limit = 20): Promise<BusiestLink[]> {
  return query<BusiestLink>(
    `SELECT l.gateway_id, l.node_id,
            COALESCE(ng.long_name, ng.short_name) AS gw_name, COALESCE(nn.long_name, nn.short_name) AS node_name,
            (l.direct_count + l.relayed_count + l.unknown_count) AS receptions
     FROM gateway_node_link l
     LEFT JOIN nodes ng ON ng.node_id = l.gateway_id
     LEFT JOIN nodes nn ON nn.node_id = l.node_id
     WHERE l.gateway_id <> l.node_id
     ORDER BY receptions DESC LIMIT ${clampLimit(limit, 100)}`,
  );
}

/** Mesh-wide hourly noise floor proxy: avg RSSI - avg SNR from the reception rollups (dBm). */
export async function noiseFloorTrend(hours = 48): Promise<{ bucket_start: string; noise: number | null }[]> {
  return query<{ bucket_start: string; noise: number | null }>(
    `SELECT bucket_start,
            CASE WHEN SUM(packet_count) > 0 THEN (SUM(rssi_sum) - SUM(snr_sum)) / SUM(packet_count) END AS noise
     FROM reception_rollup_hour
     WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND bucket_start <= UTC_TIMESTAMP()
     GROUP BY bucket_start ORDER BY bucket_start ASC`,
    [hours],
  );
}

/** SNR distribution of direct receptions (dB buckets), last 24h. */
export async function snrDistribution(hours = 24): Promise<{ bkt: number; c: number }[]> {
  return query<{ bkt: number; c: number }>(
    `SELECT CASE WHEN rx_snr >= 10 THEN 0 WHEN rx_snr >= 5 THEN 1 WHEN rx_snr >= 0 THEN 2
                 WHEN rx_snr >= -5 THEN 3 WHEN rx_snr >= -10 THEN 4 ELSE 5 END AS bkt, COUNT(*) AS c
     FROM receptions
     WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND rx_snr IS NOT NULL AND reception_class='rf_direct'
     GROUP BY bkt ORDER BY bkt`,
    [hours],
  );
}

export interface ChannelStat { channel: string; packets: number; nodes: number; messages: number }

/** Per-channel activity (packets, distinct transmitters, text messages) over a window. */
export async function channelStats(hours = 24): Promise<ChannelStat[]> {
  const pkt = await query<{ channel: string; packets: number; nodes: number }>(
    `SELECT channel_id AS channel, COUNT(*) AS packets, COUNT(DISTINCT from_node_id) AS nodes
     FROM packets
     WHERE first_seen_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND channel_id IS NOT NULL AND channel_id <> ''
     GROUP BY channel_id ORDER BY packets DESC LIMIT 50`,
    [hours],
  );
  const msg = await query<{ channel: string; c: number }>(
    `SELECT channel_id AS channel, COUNT(*) c FROM text_message
     WHERE observed_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND channel_id IS NOT NULL AND channel_id <> ''
     GROUP BY channel_id`,
    [hours],
  );
  const msgMap = new Map(msg.map((m) => [m.channel, Number(m.c)]));
  return pkt.map((p) => ({ channel: p.channel, packets: Number(p.packets), nodes: Number(p.nodes), messages: msgMap.get(p.channel) ?? 0 }));
}

/** Recent traceroute round-trip times (ms), for the RTT distribution card. */
export async function tracerouteRttSamples(days = 7, limit = 5000): Promise<number[]> {
  const rows = await query<{ rtt_ms: number }>(
    `SELECT rtt_ms FROM link_events
     WHERE rtt_ms IS NOT NULL AND rtt_ms > 0 AND observed_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     LIMIT ${clampLimit(limit, 20000)}`,
    [days],
  );
  return rows.map((r) => Number(r.rtt_ms)).filter((n) => Number.isFinite(n));
}

/** Resolve node ids to display names (long, else short) in one query, for rendering routes/hops. */
export async function nodeNamesFor(ids: number[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((n) => Number.isFinite(n) && n > 0))];
  if (uniq.length === 0) return new Map();
  const rows = await query<{ node_id: number; long_name: string | null; short_name: string | null }>(
    `SELECT node_id, long_name, short_name FROM nodes WHERE node_id IN (${uniq.map(() => "?").join(",")})`,
    uniq,
  );
  const m = new Map<number, string>();
  for (const r of rows) { const nm = r.long_name || r.short_name; if (nm) m.set(Number(r.node_id), nm); }
  return m;
}

export async function listTraceroutes(limit = 100): Promise<TracerouteRow[]> {
  const rows = await query<Omit<TracerouteRow, "route"> & { route: string | null }>(
    `SELECT l.id, l.from_node_id, l.to_node_id, l.observed_at, l.hop_count, l.route,
            n.long_name AS from_name
     FROM link_events l LEFT JOIN nodes n ON n.node_id = l.from_node_id
     WHERE l.route IS NOT NULL
     ORDER BY l.observed_at DESC LIMIT ${clampLimit(limit, 500)}`,
  );
  return rows.map((r) => ({ ...r, route: r.route ? (JSON.parse(r.route) as number[]) : null }));
}

export async function getPairHistory(gatewayId: number, nodeId: number, hours = 168): Promise<{ t: string; rssi: number | null; snr: number | null; direct: number }[]> {
  return query(
    // Direct-only series (Rule 4), falling back to the blended average only for hours that had
    // no direct reception at all, so the trace is not punched full of gaps.
    `SELECT bucket_start AS t,
            COALESCE(rssi_direct_sum / NULLIF(rssi_direct_count, 0),
                     rssi_sum / NULLIF(direct_count + relayed_count + unknown_count, 0)) AS rssi,
            COALESCE(snr_direct_sum / NULLIF(snr_direct_count, 0),
                     snr_sum / NULLIF(direct_count + relayed_count + unknown_count, 0)) AS snr,
            direct_count AS direct
     FROM reception_rollup_hour
     WHERE gateway_id=? AND node_id=? AND bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND bucket_start <= UTC_TIMESTAMP()
     ORDER BY bucket_start ASC`,
    [gatewayId, nodeId, hours],
  );
}

export interface GatewayCompareRow {
  gateway_id: number;
  gateway_name: string | null;
  direct_nodes: number;
  relayed_nodes: number;
  total_receptions: number;
  avg_direct_rssi: number | null;
}

export async function gatewayCompare(): Promise<GatewayCompareRow[]> {
  return query<GatewayCompareRow>(
    `SELECT gw.gateway_id,
            COALESCE(n.long_name, n.short_name) AS gateway_name,
            SUM(l.status='direct') AS direct_nodes,
            SUM(l.status='relayed') AS relayed_nodes,
            SUM(l.direct_count + l.relayed_count + l.unknown_count) AS total_receptions,
            -- Direct-only: rssi_sum blends relayed hops, whose RF describes the relay's link to
            -- the gateway, not the source node's (Rule 4).
            AVG(l.rssi_direct_sum / NULLIF(l.rssi_direct_count, 0)) AS avg_direct_rssi
     FROM gateways gw
     LEFT JOIN gateway_node_link l ON l.gateway_id = gw.gateway_id
     LEFT JOIN nodes n ON n.node_id = gw.gateway_id
     WHERE gw.active=1
     GROUP BY gw.gateway_id, n.long_name, n.short_name ORDER BY direct_nodes DESC`,
  );
}

export interface LongestLinkRow {
  gateway_id: number;
  node_id: number;
  node_name: string | null;
  distance_km: number;
  last_rssi: number | null;
  last_snr: number | null;
  last_direct_at: string | null;
}

export async function longestDirectLinks(limit = 50): Promise<LongestLinkRow[]> {
  // Haversine between gateway and node positions for confirmed direct links.
  return query<LongestLinkRow>(
    `SELECT l.gateway_id, l.node_id, nn.long_name AS node_name,
            6371 * ACOS(GREATEST(-1, LEAST(1, COS(RADIANS(gp.latitude))*COS(RADIANS(np.latitude))*
              COS(RADIANS(np.longitude)-RADIANS(gp.longitude)) +
              SIN(RADIANS(gp.latitude))*SIN(RADIANS(np.latitude))))) AS distance_km,
            l.last_rssi, l.last_snr, l.last_direct_at
     FROM gateway_node_link l
     JOIN node_positions gp ON gp.node_id = l.gateway_id
     JOIN node_positions np ON np.node_id = l.node_id
     LEFT JOIN nodes nn ON nn.node_id = l.node_id
     JOIN nodes gwn ON gwn.node_id = l.gateway_id
     WHERE l.direct_count > 0
       AND gp.latitude IS NOT NULL AND np.latitude IS NOT NULL
       AND l.gateway_id <> l.node_id
       AND gwn.mute_hidden = 0 AND gwn.position_ignored = 0
       AND (nn.mute_hidden = 0 OR nn.mute_hidden IS NULL) AND (nn.position_ignored = 0 OR nn.position_ignored IS NULL)
     HAVING distance_km <= 500
     ORDER BY distance_km DESC LIMIT ${clampLimit(limit, 200)}`,
  );
}

export interface SpammerRow {
  node_id: number;
  long_name: string | null;
  short_name: string | null;
  spam_score: number | null;
  total_reception_count: number;
  mute_hidden: number;
}

export async function topSpammers(limit = 50): Promise<SpammerRow[]> {
  return query<SpammerRow>(
    `SELECT node_id, long_name, short_name, spam_score, total_reception_count, mute_hidden
     FROM nodes
     WHERE spam_score IS NOT NULL OR mute_hidden = 1
     ORDER BY mute_hidden DESC, spam_score DESC LIMIT ${clampLimit(limit, 200)}`,
  );
}

export async function listMuted(): Promise<{ node_id: number; reason: string | null; added_by: string | null; added_at: string; source: string }[]> {
  return query(
    `SELECT node_id, reason, added_by, added_at, source FROM mute_list ORDER BY added_at DESC`,
  );
}

/** What a node transmits: packet counts per portnum over a window. */
export function nodePortBreakdown(nodeId: number, days = 14): Promise<{ port_num: number | null; c: number }[]> {
  return query(
    `SELECT port_num, COUNT(*) AS c FROM packets
     WHERE from_node_id = ? AND first_seen_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     GROUP BY port_num ORDER BY c DESC`,
    [nodeId, days],
  );
}

/** Recent text messages sent by a node, for its page. */
export function nodeRecentMessages(nodeId: number, limit = 10): Promise<{ observed_at: string; channel_id: string | null; body: string }[]> {
  return query(
    `SELECT observed_at, channel_id, body FROM text_message
     WHERE from_node_id = ? ORDER BY observed_at DESC LIMIT ${clampLimit(limit, 50)}`,
    [nodeId],
  );
}

/** Packet activity as a day-of-week (1=Sun..7=Sat) x hour-of-day grid, from the hourly rollup. */
export function nodeActivityHeatmap(nodeId: number, days = 28): Promise<{ dow: number; hour: number; c: number }[]> {
  return query(
    `SELECT DAYOFWEEK(bucket_start) AS dow, HOUR(bucket_start) AS hour, SUM(packet_count) AS c
     FROM node_rollup_hour WHERE node_id = ? AND bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     GROUP BY dow, hour`,
    [nodeId, days],
  );
}

/** Best observed RSSI/SNR per hour (direct receptions only), for a signal-quality trend chart.
 * Uses the direct-only rollup columns so relayed hops do not pollute the node's link quality. */
export function nodeSignalTrend(nodeId: number, hours = 168): Promise<{ t: string; rssi: number | null; snr: number | null }[]> {
  return query(
    `SELECT bucket_start AS t, MAX(rssi_direct_p50) AS rssi, MAX(snr_direct_p50) AS snr
     FROM reception_rollup_hour
     WHERE node_id = ? AND bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND bucket_start <= UTC_TIMESTAMP() AND direct_count > 0
     GROUP BY bucket_start ORDER BY bucket_start`,
    [nodeId, hours],
  );
}

/** Position history (oldest first), for a mobility track on the mini-map. */
export function nodePositionTrack(nodeId: number, limit = 100): Promise<{ latitude: number; longitude: number; observed_at: string }[]> {
  return query(
    `SELECT latitude, longitude, observed_at FROM node_position_events
     WHERE node_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY observed_at ASC LIMIT ${clampLimit(limit, 500)}`,
    [nodeId],
  );
}

/** Direct/relayed reach: how reliably and how widely a node is heard. */
/** Direct-link RSSI vs computed distance (zero-hop only, per Rule 4) for the path-loss scatter. */
export async function rssiVsDistance(limit = 2000): Promise<{ distance_km: number; rssi: number }[]> {
  return query<{ distance_km: number; rssi: number }>(
    `SELECT 6371*ACOS(LEAST(1, COS(RADIANS(gp.latitude))*COS(RADIANS(np.latitude))*
              COS(RADIANS(np.longitude)-RADIANS(gp.longitude))+SIN(RADIANS(gp.latitude))*SIN(RADIANS(np.latitude)))) AS distance_km,
            (l.rssi_sum / NULLIF(l.direct_count,0)) AS rssi
     FROM gateway_node_link l
     JOIN node_positions gp ON gp.node_id = l.gateway_id
     JOIN node_positions np ON np.node_id = l.node_id
     JOIN nodes gwn ON gwn.node_id = l.gateway_id
     JOIN nodes nn ON nn.node_id = l.node_id
     WHERE l.direct_count > 0 AND l.relayed_count = 0 AND l.unknown_count = 0
       AND l.rssi_sum IS NOT NULL AND l.gateway_id <> l.node_id
       AND gp.latitude IS NOT NULL AND np.latitude IS NOT NULL
       AND gwn.mute_hidden = 0 AND gwn.position_ignored = 0
       AND (nn.mute_hidden = 0 OR nn.mute_hidden IS NULL)
       AND (nn.position_ignored = 0 OR nn.position_ignored IS NULL)
     -- Same spoofed-position guard the DX records and longestDirectLinks already apply: one node
     -- self-reporting a position in Antarctica, heard direct once by a real gateway, added a
     -- ~15000 km point that visibly flattened the whole path-loss regression, and marking that node
     -- position_ignored in /admin did not remove it.
     HAVING distance_km > 0.05 AND distance_km <= 500 AND rssi IS NOT NULL
     ORDER BY distance_km DESC LIMIT ${clampLimit(limit, 5000)}`,
  );
}

export async function nodeReliability(nodeId: number): Promise<{ direct: number; relayed: number; gateways: number; brokers: number }> {
  const rows = await query<{ direct: number; relayed: number; gateways: number; brokers: number }>(
    `SELECT COALESCE(SUM(l.direct_count),0) AS direct, COALESCE(SUM(l.relayed_count),0) AS relayed,
            COUNT(DISTINCT l.gateway_id) AS gateways, COUNT(DISTINCT gw.broker_id) AS brokers
     FROM gateway_node_link l LEFT JOIN gateways gw ON gw.gateway_id = l.gateway_id
     WHERE l.node_id = ? AND (l.direct_count > 0 OR l.relayed_count > 0)`,
    [nodeId],
  );
  const r = rows[0];
  return { direct: Number(r?.direct ?? 0), relayed: Number(r?.relayed ?? 0), gateways: Number(r?.gateways ?? 0), brokers: Number(r?.brokers ?? 0) };
}

/** Farthest gateway that heard this node direct (needs both positions), in km. */
export async function nodeFarthestGateway(nodeId: number): Promise<{ gateway_id: number; distance_km: number; last_rssi: number | null } | null> {
  const rows = await query<{ gateway_id: number; distance_km: number; last_rssi: number | null }>(
    `SELECT l.gateway_id, l.last_rssi,
            6371*ACOS(LEAST(1, COS(RADIANS(gp.latitude))*COS(RADIANS(np.latitude))*
              COS(RADIANS(np.longitude)-RADIANS(gp.longitude))+SIN(RADIANS(gp.latitude))*SIN(RADIANS(np.latitude)))) AS distance_km
     FROM gateway_node_link l
     JOIN node_positions gp ON gp.node_id = l.gateway_id
     JOIN node_positions np ON np.node_id = l.node_id
     WHERE l.node_id = ? AND l.direct_count > 0 AND l.gateway_id <> l.node_id
       AND gp.latitude IS NOT NULL AND np.latitude IS NOT NULL
     ORDER BY distance_km DESC LIMIT 1`,
    [nodeId],
  );
  return rows[0] ?? null;
}

/** Hop-count distribution of this node's receptions (0 = direct). */
export function nodeHopProfile(nodeId: number, days = 14): Promise<{ hops: number; c: number }[]> {
  return query(
    `SELECT (hop_start - hop_limit) AS hops, COUNT(*) AS c FROM receptions
     WHERE from_node_id = ? AND hop_start IS NOT NULL AND hop_limit IS NOT NULL
       AND reception_class IN ('rf_direct','rf_relayed')
       AND rx_time >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     GROUP BY hops ORDER BY hops`,
    [nodeId, days],
  );
}

/** Latest value of a telemetry metric for a node (e.g. uptime). */
export async function nodeLatestMetric(nodeId: number, metric: string): Promise<number | null> {
  const rows = await query<{ value: number }>(
    `SELECT value FROM node_telemetry WHERE node_id = ? AND metric = ? ORDER BY observed_at DESC LIMIT 1`,
    [nodeId, metric],
  );
  return rows[0] ? Number(rows[0].value) : null;
}

/** Channels a node transmits on. */
export async function nodeChannels(nodeId: number): Promise<string[]> {
  const rows = await query<{ channel_id: string }>(
    `SELECT DISTINCT channel_id FROM packets WHERE from_node_id = ? AND channel_id IS NOT NULL AND channel_id <> '' LIMIT 20`,
    [nodeId],
  );
  return rows.map((r) => r.channel_id);
}

export interface RouterBatteryRow {
  node_id: number; long_name: string | null; short_name: string | null; role: string | null;
  last_seen_at: string | null; battery: number | null; voltage: number | null;
  power_profile: string | null; projected_dead_at: string | null; slope_v_per_day: number | null;
}

/** Infrastructure nodes (routers/repeaters) with their latest battery % + forecast, for the
 *  router battery dashboard. Lowest battery first so the ones needing attention float up. */
export function routerBatteryFleet(): Promise<RouterBatteryRow[]> {
  return query<RouterBatteryRow>(
    `SELECT n.node_id, n.long_name, n.short_name, n.role, n.last_seen_at,
            b.battery, bf.current_voltage AS voltage, bf.power_profile, bf.projected_dead_at, bf.slope_v_per_day
     FROM nodes n
     LEFT JOIN (
       SELECT t.node_id, t.value AS battery
       FROM node_telemetry t
       JOIN (SELECT node_id, MAX(observed_at) mo FROM node_telemetry WHERE metric='battery_pct' AND observed_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY) GROUP BY node_id) x
         ON x.node_id = t.node_id AND t.observed_at = x.mo AND t.metric = 'battery_pct'
     ) b ON b.node_id = n.node_id
     LEFT JOIN battery_forecast bf ON bf.node_id = n.node_id
     WHERE UPPER(COALESCE(n.role,'')) IN ('ROUTER','ROUTER_CLIENT','REPEATER')
       AND (n.mute_hidden = 0 OR n.mute_hidden IS NULL)
     ORDER BY (b.battery IS NULL), b.battery ASC, n.last_seen_at DESC`,
  );
}

/** How talkative a node is vs the rest of the mesh, as a 0-100 percentile. */
export async function nodeChattinessPercentile(packetCount: number): Promise<number | null> {
  const rows = await query<{ below: number; total: number }>(
    `SELECT (SELECT COUNT(*) FROM nodes WHERE total_packet_count < ?) AS below, (SELECT COUNT(*) FROM nodes) AS total`,
    [packetCount],
  );
  const r = rows[0];
  if (!r || Number(r.total) === 0) return null;
  return Math.round((Number(r.below) / Number(r.total)) * 100);
}

// ---------------------------------------------------------------------------
// Phase 4: health, records, propagation, best-gateway, replay, weather, link budget
// ---------------------------------------------------------------------------

export async function getHealthSnapshot(): Promise<{ score: number | null; breakdown: any; computed_at: string | null } | null> {
  const rows = await query<{ score: number | null; breakdown: any; computed_at: string | null }>(
    `SELECT score, breakdown, computed_at FROM health_snapshot WHERE id=1`,
  );
  const r = rows[0];
  if (!r) return null;
  return { ...r, breakdown: typeof r.breakdown === "string" ? JSON.parse(r.breakdown) : r.breakdown };
}

export interface RecordRow {
  record_type: string;
  value: number;
  unit: string | null;
  node_a: number | null;
  node_b: number | null;
  achieved_at: string;
  evidence: any;
}

export async function getRecords(): Promise<RecordRow[]> {
  const rows = await query<RecordRow>(`SELECT * FROM records ORDER BY record_type`);
  return rows.map((r) => ({ ...r, evidence: typeof r.evidence === "string" ? JSON.parse(r.evidence) : r.evidence }));
}

export async function listPropagationEvents(limit = 100): Promise<
  { id: number; gateway_id: number; node_id: number; detected_at: string; event_type: string; baseline_rssi: number | null; observed_rssi: number | null; delta_db: number; distance_km: number | null; node_name: string | null }[]
> {
  return query(
    `SELECT e.id, e.gateway_id, e.node_id, e.detected_at, e.event_type, e.baseline_rssi, e.observed_rssi,
            e.delta_db, e.distance_km, n.long_name AS node_name
     FROM propagation_events e LEFT JOIN nodes n ON n.node_id=e.node_id
     ORDER BY e.detected_at DESC LIMIT ${clampLimit(limit, 500)}`,
  );
}

export async function bestGatewaysForNode(nodeId: number): Promise<
  { gateway_id: number; status: string; direct_count: number; relayed_count: number; avg_rssi: number | null; avg_snr: number | null; last_direct_at: string | null }[]
> {
  return query(
    // avg_rssi/avg_snr are DIRECT-only so "best gateway" ranks by the node's own zero-hop link
    // (Rule 4); avg_rssi_all keeps the blended figure for context, labelled honestly.
    `SELECT gateway_id, status, direct_count, relayed_count,
            rssi_direct_sum/NULLIF(rssi_direct_count,0) AS avg_rssi,
            snr_direct_sum/NULLIF(snr_direct_count,0) AS avg_snr,
            rssi_sum/NULLIF(direct_count+relayed_count+unknown_count,0) AS avg_rssi_all,
            last_direct_at
     FROM gateway_node_link WHERE node_id=?
     ORDER BY (status='direct') DESC, avg_rssi DESC LIMIT 20`,
    [nodeId],
  );
}

export interface ReplayData {
  frames: { bucket: string; receptions: number; active: number[] }[];
  positions: Record<number, [number, number]>; // node_id -> [lon, lat]
}

export async function getReplayData(hours = 72): Promise<ReplayData> {
  const rows = await query<{ bucket: string; node_id: number; receptions: number }>(
    `SELECT DATE_FORMAT(bucket_start,'%Y-%m-%d %H:00:00') AS bucket, node_id, reception_count AS receptions
     FROM node_rollup_hour WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
     ORDER BY bucket ASC`,
    [hours],
  );
  const positions: Record<number, [number, number]> = {};
  const posRows = await query<{ node_id: number; latitude: number; longitude: number }>(
    // Same suppression the map queries apply: a node the operator marked position_ignored (or
    // muted) must not appear here either, or the replay animates a position /map refuses to show.
    `SELECT np.node_id, np.latitude, np.longitude FROM node_positions np
     JOIN nodes n ON n.node_id = np.node_id
     WHERE np.latitude IS NOT NULL AND np.longitude IS NOT NULL
       AND (n.position_ignored = 0 OR n.position_ignored IS NULL)
       AND (n.mute_hidden = 0 OR n.mute_hidden IS NULL)`,
  );
  for (const p of posRows) positions[p.node_id] = [p.longitude, p.latitude];

  const byBucket = new Map<string, { receptions: number; active: number[] }>();
  for (const r of rows) {
    let f = byBucket.get(r.bucket);
    if (!f) {
      f = { receptions: 0, active: [] };
      byBucket.set(r.bucket, f);
    }
    f.receptions += Number(r.receptions);
    if (positions[r.node_id]) f.active.push(r.node_id);
  }
  const frames = [...byBucket.entries()].map(([bucket, v]) => ({ bucket, ...v }));
  return { frames, positions };
}

export async function getLinkBudgets(limit = 100): Promise<
  { node_a: number; node_b: number; node_name: string | null; distance_km: number | null; expected_path_loss_db: number | null; fresnel_clearance: number | null; observed_rssi: number | null; deficit_db: number | null }[]
> {
  return query(
    `SELECT b.node_a, b.node_b, n.long_name AS node_name, b.distance_km, b.expected_path_loss_db,
            b.fresnel_clearance, b.observed_rssi, b.deficit_db
     FROM terrain_link_budget b LEFT JOIN nodes n ON n.node_id=b.node_b
     ORDER BY b.deficit_db DESC LIMIT ${clampLimit(limit, 500)}`,
  );
}

export async function getWeatherReport(hours = 168): Promise<{
  weather: { observed_at: string; temp_c: number | null; humidity: number | null; pressure_hpa: number | null }[];
  rssi: { t: string; avg_rssi: number | null }[];
}> {
  // Clamp to [now - window, now] so a stray future-dated observation cannot stretch the axis,
  // and null out physically impossible sensor values so they do not skew the correlation.
  const weather = await query<{ observed_at: string; temp_c: number | null; humidity: number | null; pressure_hpa: number | null }>(
    `SELECT observed_at,
       CASE WHEN temp_c BETWEEN -60 AND 70 THEN temp_c END AS temp_c,
       CASE WHEN humidity BETWEEN 0 AND 100 THEN humidity END AS humidity,
       CASE WHEN pressure_hpa BETWEEN 800 AND 1100 THEN pressure_hpa END AS pressure_hpa
     FROM weather_obs
     WHERE observed_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND observed_at <= UTC_TIMESTAMP()
     ORDER BY observed_at ASC LIMIT 5000`,
    [hours],
  );
  const rssi = await query<{ t: string; avg_rssi: number | null }>(
    `SELECT DATE_FORMAT(bucket_start,'%Y-%m-%d %H:00:00') AS t, SUM(rssi_sum)/NULLIF(SUM(packet_count),0) AS avg_rssi
     FROM reception_rollup_hour WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND bucket_start <= UTC_TIMESTAMP()
     GROUP BY t ORDER BY t ASC LIMIT 5000`,
    [hours],
  );
  return { weather, rssi };
}

export interface SpaceWeatherObs {
  fetched_at: string; kp: number | null; kp_observed_at: string | null;
  solar_flux_10cm: number | null; solar_wind_kms: number | null; condition_label: string | null;
}

/** Latest space-weather reading plus a recent history series (for the /propagation panel). */
export async function getSpaceWeather(hours = 168): Promise<{ latest: SpaceWeatherObs | null; history: SpaceWeatherObs[] }> {
  const history = await query<SpaceWeatherObs>(
    `SELECT fetched_at, kp, kp_observed_at, solar_flux_10cm, solar_wind_kms, condition_label
     FROM space_weather_obs
     WHERE fetched_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) AND fetched_at <= UTC_TIMESTAMP()
     ORDER BY fetched_at ASC LIMIT 5000`,
    [hours],
  );
  const latest = history[history.length - 1] ?? null;
  return { latest, history };
}

// Environmental sensor metrics we aggregate across the mesh (from node_telemetry). Static,
// safe identifiers (no user input) so they can be inlined into the IN() list.
const ENV_METRICS = ["temperature", "humidity", "pressure", "iaq", "co2", "lux", "gas_resistance", "wind_speed", "wind_direction"];
const ENV_IN = ENV_METRICS.map((m) => `'${m}'`).join(",");

export interface MeshEnvMetric { metric: string; count: number; avg: number; min: number; max: number }
export interface MeshEnvNode { node_id: number; name: string | null; short_name: string | null; observed_at: string; values: Record<string, number> }

/** Latest environmental reading per node, aggregated mesh-wide (for the Mesh Weather page). */
export async function getMeshEnvironment(days = 1): Promise<{ metrics: MeshEnvMetric[]; nodes: MeshEnvNode[] }> {
  const rows = await query<{ node_id: number; metric: string; value: number; observed_at: string; long_name: string | null; short_name: string | null }>(
    `SELECT t.node_id, t.metric, t.value, t.observed_at, n.long_name, n.short_name
     FROM node_telemetry t
     JOIN (SELECT node_id, metric, MAX(observed_at) mo FROM node_telemetry
           WHERE metric IN (${ENV_IN}) AND observed_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
           GROUP BY node_id, metric) x
       ON x.node_id=t.node_id AND x.metric=t.metric AND x.mo=t.observed_at
     LEFT JOIN nodes n ON n.node_id=t.node_id
     WHERE t.metric IN (${ENV_IN}) AND t.observed_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     ORDER BY t.node_id LIMIT 5000`,
    [days, days],
  );

  const nodeMap = new Map<number, MeshEnvNode>();
  const perMetric = new Map<string, number[]>();
  for (const r of rows) {
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    let node = nodeMap.get(r.node_id);
    if (!node) { node = { node_id: r.node_id, name: r.long_name ?? r.short_name ?? null, short_name: r.short_name ?? null, observed_at: r.observed_at, values: {} }; nodeMap.set(r.node_id, node); }
    node.values[r.metric] = v;
    if (r.observed_at > node.observed_at) node.observed_at = r.observed_at;
    (perMetric.get(r.metric) ?? perMetric.set(r.metric, []).get(r.metric)!).push(v);
  }
  const metrics: MeshEnvMetric[] = ENV_METRICS
    .filter((m) => perMetric.has(m))
    .map((m) => {
      const vals = perMetric.get(m)!;
      return { metric: m, count: vals.length, avg: vals.reduce((a, b) => a + b, 0) / vals.length, min: Math.min(...vals), max: Math.max(...vals) };
    });
  const nodes = [...nodeMap.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return { metrics, nodes };
}

// Power/solar metrics: battery + per-channel voltage/current. Static safe identifiers.
const POWER_METRICS = ["battery_pct", "voltage", "ch1_voltage", "ch1_current", "ch2_voltage", "ch2_current", "ch3_voltage", "ch3_current"];
const POWER_IN = POWER_METRICS.map((m) => `'${m}'`).join(",");

export interface PowerNode { node_id: number; name: string | null; observed_at: string; values: Record<string, number> }

/** Latest power/solar telemetry per node, restricted to nodes reporting a power channel. */
export async function getMeshPower(days = 2): Promise<{ columns: string[]; nodes: PowerNode[] }> {
  const rows = await query<{ node_id: number; metric: string; value: number; observed_at: string; long_name: string | null; short_name: string | null }>(
    `SELECT t.node_id, t.metric, t.value, t.observed_at, n.long_name, n.short_name
     FROM node_telemetry t
     JOIN (SELECT node_id, metric, MAX(observed_at) mo FROM node_telemetry
           WHERE metric IN (${POWER_IN}) AND observed_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
           GROUP BY node_id, metric) x
       ON x.node_id=t.node_id AND x.metric=t.metric AND x.mo=t.observed_at
     LEFT JOIN nodes n ON n.node_id=t.node_id
     WHERE t.metric IN (${POWER_IN}) AND t.observed_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     ORDER BY t.node_id LIMIT 5000`,
    [days, days],
  );
  const map = new Map<number, PowerNode>();
  const present = new Set<string>();
  for (const r of rows) {
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    let node = map.get(r.node_id);
    if (!node) { node = { node_id: r.node_id, name: r.long_name ?? r.short_name ?? null, observed_at: r.observed_at, values: {} }; map.set(r.node_id, node); }
    node.values[r.metric] = v;
    if (r.observed_at > node.observed_at) node.observed_at = r.observed_at;
    present.add(r.metric);
  }
  // Only nodes that report at least one power channel (else it is just a battery reading).
  const nodes = [...map.values()].filter((n) => POWER_METRICS.slice(2).some((m) => m in n.values)).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const columns = POWER_METRICS.filter((m) => present.has(m) && (m === "battery_pct" || m === "voltage" || nodes.some((n) => m in n.values)));
  return { columns, nodes };
}

// ---------------------------------------------------------------------------
// Phase 5: fingerprinting + ghost hunter
// ---------------------------------------------------------------------------

/** Hour-of-day x day-of-week reception counts (UTC buckets) for a node's duty cycle. */
export async function getNodeFingerprint(nodeId: number, days = 28): Promise<{ dow: number; hour: number; c: number }[]> {
  return query<{ dow: number; hour: number; c: number }>(
    `SELECT (DAYOFWEEK(bucket_start)-1) AS dow, HOUR(bucket_start) AS hour, SUM(reception_count) AS c
     FROM node_rollup_hour
     WHERE node_id=? AND bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     GROUP BY dow, hour`,
    [nodeId, days],
  );
}

export interface GhostRow {
  node_id: number;
  long_name: string | null;
  short_name: string | null;
  total_reception_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  gateway_id: number | null;
  last_rssi: number | null;
  last_snr: number | null;
}

export async function ghostNodes(maxReceptions = 3, limit = 300): Promise<GhostRow[]> {
  return query<GhostRow>(
    `SELECT n.node_id, n.long_name, n.short_name, n.total_reception_count, n.first_seen_at, n.last_seen_at,
       (SELECT g.gateway_id FROM gateway_node_link g WHERE g.node_id=n.node_id
          ORDER BY COALESCE(g.last_direct_at, g.last_relayed_at) DESC LIMIT 1) AS gateway_id,
       (SELECT g.last_rssi FROM gateway_node_link g WHERE g.node_id=n.node_id
          ORDER BY COALESCE(g.last_direct_at, g.last_relayed_at) DESC LIMIT 1) AS last_rssi,
       (SELECT g.last_snr FROM gateway_node_link g WHERE g.node_id=n.node_id
          ORDER BY COALESCE(g.last_direct_at, g.last_relayed_at) DESC LIMIT 1) AS last_snr
     FROM nodes n
     WHERE n.total_reception_count > 0 AND n.total_reception_count <= ?
     ORDER BY n.total_reception_count ASC, n.last_seen_at DESC
     LIMIT ${clampLimit(limit, 1000)}`,
    [maxReceptions],
  );
}

// to_node_id is NULL for channel broadcasts; set = a directed message (DM) we overheard.
export async function listTextMessages(limit = 200, channelId?: string, q?: string): Promise<{ id: number; observed_at: string; from_node_id: number; to_node_id: number | null; from_name: string | null; channel_id: string | null; body: string; source_broker_id: string | null; source_topic: string | null; reply_to_packet_id: number | null; is_reaction: number }[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (channelId) { clauses.push("t.channel_id = ?"); params.push(channelId); }
  const term = q?.trim();
  if (term) { clauses.push("(t.body LIKE ? OR n.long_name LIKE ?)"); params.push(`%${term}%`, `%${term}%`); }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  return query(
    `SELECT t.id, t.observed_at, t.from_node_id, t.to_node_id, n.long_name AS from_name, t.channel_id, t.body, t.source_broker_id, t.source_topic,
            t.reply_to_packet_id, t.is_reaction
     FROM text_message t LEFT JOIN nodes n ON n.node_id = t.from_node_id
     ${where}
     ORDER BY t.observed_at DESC LIMIT ${clampLimit(limit, 1000)}`,
    params,
  );
}

export async function getNodeNeighbors(nodeId: number): Promise<{ direction: "reports" | "reported_by"; other: number; name: string | null; snr: number | null; updated_at: string }[]> {
  return query(
    `SELECT 'reports' AS direction, nn.neighbor_id AS other, n.long_name AS name, nn.snr, nn.updated_at
       FROM node_neighbor nn LEFT JOIN nodes n ON n.node_id = nn.neighbor_id WHERE nn.node_id = ?
     UNION ALL
     SELECT 'reported_by' AS direction, nn.node_id AS other, n.long_name AS name, nn.snr, nn.updated_at
       FROM node_neighbor nn LEFT JOIN nodes n ON n.node_id = nn.node_id WHERE nn.neighbor_id = ?
     ORDER BY updated_at DESC LIMIT 100`,
    [nodeId, nodeId],
  );
}

export interface FleetData {
  hardware: { label: string; c: number }[];
  firmware: { label: string; c: number }[];
  roles: { label: string; c: number }[];
  channels: { label: string; c: number }[];
  /** Region + modem preset distribution, from MAP_REPORT_APP self-reports. A node whose radio
   * profile differs from the rest of the mesh is visible over MQTT but cannot be heard on RF, which
   * otherwise looks identical to a node with a bad antenna. */
  regions: { label: string; c: number }[];
  presets: { label: string; c: number }[];
  /** Nodes still on the public default channel PSK, per their own map report. */
  defaultChannelNodes: { node_id: number; long_name: string | null; short_name: string | null; reported_at: string }[];
  total: number;
  active24: number;
  gateways: number;
  positioned: number;
}

export async function getFleet(): Promise<FleetData> {
  const [hardware, firmware, roles, channels, regions, presets, defaultChannelNodes, summary] = await Promise.all([
    query<{ label: string; c: number }>(`SELECT COALESCE(hw_model,'unknown') label, COUNT(*) c FROM nodes GROUP BY hw_model ORDER BY c DESC LIMIT 40`),
    query<{ label: string; c: number }>(`SELECT COALESCE(firmware_version,'unknown') label, COUNT(*) c FROM nodes GROUP BY firmware_version ORDER BY c DESC LIMIT 40`),
    query<{ label: string; c: number }>(`SELECT COALESCE(role,'unknown') label, COUNT(*) c FROM nodes GROUP BY role ORDER BY c DESC LIMIT 20`),
    // Nodes active on each channel over the last 7 days (distinct transmitters per channel).
    query<{ label: string; c: number }>(
      `SELECT COALESCE(NULLIF(channel_id,''),'(unnamed)') label, COUNT(DISTINCT from_node_id) c
       FROM packets WHERE first_seen_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)
       GROUP BY channel_id ORDER BY c DESC LIMIT 40`,
    ),
    query<{ label: string; c: number }>(
      `SELECT region label, COUNT(*) c FROM nodes WHERE region IS NOT NULL GROUP BY region ORDER BY c DESC LIMIT 40`,
    ),
    query<{ label: string; c: number }>(
      `SELECT modem_preset label, COUNT(*) c FROM nodes WHERE modem_preset IS NOT NULL GROUP BY modem_preset ORDER BY c DESC LIMIT 40`,
    ),
    query<{ node_id: number; long_name: string | null; short_name: string | null; reported_at: string }>(
      `SELECT node_id, long_name, short_name, radio_profile_at AS reported_at FROM nodes
        WHERE has_default_channel = 1 ORDER BY radio_profile_at DESC LIMIT 100`,
    ),
    query<{ total: number; active24: number; gateways: number; positioned: number }>(
      `SELECT COUNT(*) total,
         SUM(last_seen_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR) active24,
         SUM(is_gateway=1) gateways,
         SUM(last_position_at IS NOT NULL) positioned
       FROM nodes`,
    ),
  ]);
  const s = summary[0];
  return {
    hardware, firmware, roles, channels, regions, presets, defaultChannelNodes,
    total: Number(s?.total ?? 0), active24: Number(s?.active24 ?? 0),
    gateways: Number(s?.gateways ?? 0), positioned: Number(s?.positioned ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Node "reach": how far and how well one node's transmissions propagate, in the spirit of CoreScope's
// reach page but on Meshtastic data. Direct receivers = gateways that heard it at 0 hops (from the
// pre-aggregated gateway_node_link roster, so no receptions scan); links = NeighborInfo node-to-node
// adjacency, both directions; importance = neighbor degree + rank + how often it was heard relayed.
// ---------------------------------------------------------------------------
export interface ReachReceiver {
  gateway_id: number; name: string | null; owner_node_id: number | null;
  lat: number | null; lon: number | null;
  count: number; avg_snr: number | null; avg_rssi: number | null;
  last_at: string | null; distance_km: number | null;
}
export interface ReachLink {
  other: number; name: string | null; role: string | null;
  we_hear: boolean; they_hear: boolean; bidir: boolean;
  snr_out: number | null; snr_in: number | null; updated_at: string | null;
}
export interface ReachTrend {
  prev_direct_receivers: number;
  gained: { id: number; name: string | null }[];
  lost: { id: number; name: string | null }[];
  daily: { d: string; receivers: number }[];
}
export interface NodeReach {
  node: { node_id: number; long_name: string | null; short_name: string | null; role: string | null; lat: number | null; lon: number | null; first_seen_at: string | null };
  window_days: number;
  summary: {
    direct_receivers: number; neighbor_degree: number; degree_rank: number | null; nodes_ranked: number;
    bidirectional_links: number; heard_relayed: number; max_distance_km: number | null;
    // Redundancy / single-point-of-failure: how independently this node is carried to the network.
    top_gateway_share: number | null; is_spof: boolean;
    // Link margin: the demod SNR floor for this node's modem preset, so each link reads as headroom.
    modem_preset: string | null; demod_floor_db: number;
    // Plain-language verdict for newcomers.
    grade: string; grade_score: number; grade_reason: string;
  };
  trend: ReachTrend;
  tips: string[];
  receivers: ReachReceiver[];
  relayers: ReachReceiver[]; // gateways that carry this node's traffic via a relay (not direct)
  links: ReachLink[];
}

// Approximate demodulation SNR floor (dB) per Meshtastic modem preset: a link's headroom above this
// is what actually predicts whether it holds. Derived from the preset's spreading factor (~2.5 dB per
// SF step). Unknown/unset presets fall back to LONG_FAST, the region default.
const DEMOD_FLOOR_DB: Record<string, number> = {
  SHORT_TURBO: -7, SHORT_FAST: -7.5, SHORT_SLOW: -10,
  MEDIUM_FAST: -12.5, MEDIUM_SLOW: -15,
  // LongTurbo is SF11 like LongFast but at BW500 (double the noise bandwidth), so ~2.5 dB less
  // sensitive. It is the US firmware default as of v2.8, so it needs its own floor here.
  LONG_TURBO: -15,
  LONG_FAST: -17.5, LONG_MODERATE: -20, LONG_SLOW: -20, VERY_LONG_SLOW: -22.5,
  // TinyFast/TinySlow (v2.8) use an ultra-narrow 15.6 kHz bandwidth for maximum range at tiny
  // throughput; these floors are approximate (from the bandwidth, exact SF unconfirmed).
  TINY_FAST: -25, TINY_SLOW: -28,
};

export async function getNodeReach(nodeId: number, days = 7): Promise<NodeReach | null> {
  const d = clampLimit(days, 90, 7);
  const [node] = await query<{ node_id: number; long_name: string | null; short_name: string | null; role: string | null; first_seen_at: string | null; lat: number | null; lon: number | null; modem_preset: string | null }>(
    `SELECT n.node_id, n.long_name, n.short_name, n.role, n.first_seen_at, n.modem_preset, p.latitude AS lat, p.longitude AS lon
     FROM nodes n LEFT JOIN node_positions p ON p.node_id = n.node_id WHERE n.node_id = ?`,
    [nodeId],
  );
  if (!node) return null;
  const floor: number = DEMOD_FLOOR_DB[(node.modem_preset ?? "").toUpperCase()] ?? -17.5;

  // Direct receivers: gateways that heard this node at 0 hops in the window. Averages are over all of
  // that link's receptions (per-direct averages are not stored separately); count is the direct count.
  const recRows = await query<{ gateway_id: number; count: number; avg_snr: number | null; avg_rssi: number | null; last_at: string | null; owner_node_id: number | null; name: string | null; gshort: string | null; lat: number | null; lon: number | null }>(
    `SELECT l.gateway_id, l.direct_count AS count,
            l.snr_sum  / NULLIF(l.direct_count + l.relayed_count + l.unknown_count, 0) AS avg_snr,
            l.rssi_sum / NULLIF(l.direct_count + l.relayed_count + l.unknown_count, 0) AS avg_rssi,
            l.last_direct_at AS last_at, COALESCE(g.owner_node_id, l.gateway_id) AS owner_node_id,
            gn.long_name AS name, gn.short_name AS gshort, gp.latitude AS lat, gp.longitude AS lon
     FROM gateway_node_link l
     JOIN gateways g ON g.gateway_id = l.gateway_id
     -- The gateway_id IS the gateway's node num, so resolve its identity/position from owner_node_id
     -- when set, else from gateway_id directly (most gateways have no separate owner record).
     LEFT JOIN nodes gn ON gn.node_id = COALESCE(g.owner_node_id, l.gateway_id)
     LEFT JOIN node_positions gp ON gp.node_id = COALESCE(g.owner_node_id, l.gateway_id)
     WHERE l.node_id = ? AND l.direct_count > 0 AND l.last_direct_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     ORDER BY l.direct_count DESC LIMIT 300`,
    [nodeId, d],
  );
  // A zero-hop RF reception cannot span more than a few hundred km (line-of-sight LoRa DX tops out
  // ~300 km), so a farther "distance" or a null-island (0,0) fix is a bad position: drop its
  // coordinates so it never skews the max-reach stat or the map's bounds.
  const MAX_RF_KM = 400;
  const receivers: ReachReceiver[] = recRows.map((r) => {
    let lat = r.lat != null ? Number(r.lat) : null;
    let lon = r.lon != null ? Number(r.lon) : null;
    if (lat === 0 && lon === 0) { lat = null; lon = null; }
    let dist: number | null = null;
    if (lat != null && lon != null && node.lat != null && node.lon != null) {
      const km = haversineKm({ lat: Number(node.lat), lon: Number(node.lon) }, { lat, lon });
      if (km <= MAX_RF_KM) dist = km; else { lat = null; lon = null; }
    }
    return {
      gateway_id: r.gateway_id, name: r.name ?? r.gshort ?? null, owner_node_id: r.owner_node_id ?? null,
      lat, lon, count: Number(r.count), avg_snr: r.avg_snr != null ? Number(r.avg_snr) : null,
      avg_rssi: r.avg_rssi != null ? Number(r.avg_rssi) : null, last_at: r.last_at, distance_km: dist,
    };
  });

  // Relayed-by: gateways that carry this node's traffic via a relay (heard it but never at 0 hops).
  // This is a router's real footprint. Distance is left null: a relayed reception is not a direct
  // link, so its geographic gap is not an RF range (Rule 4). Positions are kept for the map layer.
  const relRows = await query<typeof recRows[number]>(
    `SELECT l.gateway_id, l.relayed_count AS count,
            l.snr_sum / NULLIF(l.direct_count + l.relayed_count + l.unknown_count, 0) AS avg_snr,
            l.rssi_sum / NULLIF(l.direct_count + l.relayed_count + l.unknown_count, 0) AS avg_rssi,
            l.last_relayed_at AS last_at, COALESCE(g.owner_node_id, l.gateway_id) AS owner_node_id,
            gn.long_name AS name, gn.short_name AS gshort, gp.latitude AS lat, gp.longitude AS lon
     FROM gateway_node_link l
     JOIN gateways g ON g.gateway_id = l.gateway_id
     LEFT JOIN nodes gn ON gn.node_id = COALESCE(g.owner_node_id, l.gateway_id)
     LEFT JOIN node_positions gp ON gp.node_id = COALESCE(g.owner_node_id, l.gateway_id)
     WHERE l.node_id = ? AND l.relayed_count > 0 AND l.direct_count = 0 AND l.last_relayed_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     ORDER BY l.relayed_count DESC LIMIT 300`,
    [nodeId, d],
  );
  const relayers: ReachReceiver[] = relRows.map((r) => {
    let lat = r.lat != null ? Number(r.lat) : null;
    let lon = r.lon != null ? Number(r.lon) : null;
    if (lat === 0 && lon === 0) { lat = null; lon = null; }
    return {
      gateway_id: r.gateway_id, name: r.name ?? r.gshort ?? null, owner_node_id: r.owner_node_id ?? null,
      lat, lon, count: Number(r.count), avg_snr: r.avg_snr != null ? Number(r.avg_snr) : null,
      avg_rssi: r.avg_rssi != null ? Number(r.avg_rssi) : null, last_at: r.last_at, distance_km: null,
    };
  });

  // NeighborInfo links, both directions, in the window.
  const win = `updated_at >= (UTC_TIMESTAMP() - INTERVAL ${d} DAY)`;
  const outRows = await query<{ other: number; snr: number | null; updated_at: string }>(
    `SELECT neighbor_id AS other, snr, updated_at FROM node_neighbor WHERE node_id = ? AND ${win}`, [nodeId]);
  const inRows = await query<{ other: number; snr: number | null; updated_at: string }>(
    `SELECT node_id AS other, snr, updated_at FROM node_neighbor WHERE neighbor_id = ? AND ${win}`, [nodeId]);
  const linkMap = new Map<number, ReachLink>();
  for (const r of outRows) linkMap.set(r.other, { other: r.other, name: null, role: null, we_hear: true, they_hear: false, bidir: false, snr_out: r.snr, snr_in: null, updated_at: r.updated_at });
  for (const r of inRows) {
    const e = linkMap.get(r.other);
    if (e) { e.they_hear = true; e.bidir = true; e.snr_in = r.snr; if (r.updated_at > (e.updated_at ?? "")) e.updated_at = r.updated_at; }
    else linkMap.set(r.other, { other: r.other, name: null, role: null, we_hear: false, they_hear: true, bidir: false, snr_out: null, snr_in: r.snr, updated_at: r.updated_at });
  }
  const others = [...linkMap.keys()];
  if (others.length) {
    const meta = await query<{ node_id: number; long_name: string | null; short_name: string | null; role: string | null }>(
      `SELECT node_id, long_name, short_name, role FROM nodes WHERE node_id IN (${others.join(",")})`);
    const mm = new Map(meta.map((m) => [m.node_id, m]));
    for (const l of linkMap.values()) { const m = mm.get(l.other); if (m) { l.name = m.long_name ?? m.short_name ?? null; l.role = m.role; } }
  }
  const links = [...linkMap.values()].sort((a, b) => (b.bidir ? 1 : 0) - (a.bidir ? 1 : 0) || (b.snr_out ?? -99) - (a.snr_out ?? -99));

  const [hr] = await query<{ s: number | null }>(
    `SELECT SUM(relayed_count) s FROM gateway_node_link WHERE node_id = ? AND last_relayed_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)`, [nodeId, d]);

  // Undirected neighbor degree for every node (UNION dedups the (id,other) pair), for this node's
  // degree and its rank. node_neighbor is small relative to receptions, so the full pass is cheap.
  const degRows = await query<{ id: number; deg: number }>(
    `SELECT id, COUNT(DISTINCT other) deg FROM (
       SELECT node_id AS id, neighbor_id AS other FROM node_neighbor WHERE ${win}
       UNION SELECT neighbor_id AS id, node_id AS other FROM node_neighbor WHERE ${win}
     ) u GROUP BY id`);
  const myDeg = Number(degRows.find((r) => Number(r.id) === nodeId)?.deg ?? links.length);
  const rank = degRows.length ? 1 + degRows.filter((r) => Number(r.deg) > myDeg).length : null;

  // Reach over time: this window vs the preceding one (gained/lost direct receivers) plus a daily
  // sparkline, from the hourly rollup (direct receptions only; the current incomplete hour lives in
  // the raw tail and is negligible at this scale).
  const trendRows = await query<{ gateway_id: number; cur: number; prev: number }>(
    `SELECT gateway_id,
            SUM(CASE WHEN bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? DAY) THEN direct_count ELSE 0 END) cur,
            SUM(CASE WHEN bucket_start <  (UTC_TIMESTAMP() - INTERVAL ? DAY) THEN direct_count ELSE 0 END) prev
     FROM reception_rollup_hour
     WHERE node_id = ? AND direct_count > 0 AND bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     GROUP BY gateway_id`,
    [d, d, nodeId, d * 2],
  );
  const curSet = new Set(trendRows.filter((r) => Number(r.cur) > 0).map((r) => r.gateway_id));
  const prevSet = new Set(trendRows.filter((r) => Number(r.prev) > 0).map((r) => r.gateway_id));
  const gainedIds = [...curSet].filter((g) => !prevSet.has(g));
  const lostIds = [...prevSet].filter((g) => !curSet.has(g));
  const chNames = new Map<number, string | null>();
  const chIds = [...new Set([...gainedIds, ...lostIds])];
  if (chIds.length) {
    const nm = await query<{ node_id: number; long_name: string | null; short_name: string | null }>(
      `SELECT node_id, long_name, short_name FROM nodes WHERE node_id IN (${chIds.join(",")})`);
    for (const m of nm) chNames.set(m.node_id, m.long_name ?? m.short_name ?? null);
  }
  const nameFor = (id: number) => ({ id, name: chNames.get(id) ?? null });
  const dailyRows = await query<{ d: string; c: number }>(
    `SELECT DATE(bucket_start) d, COUNT(DISTINCT gateway_id) c FROM reception_rollup_hour
     WHERE node_id = ? AND direct_count > 0 AND bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     GROUP BY DATE(bucket_start) ORDER BY d`,
    [nodeId, d * 2],
  );
  const trend: ReachTrend = {
    prev_direct_receivers: prevSet.size,
    gained: gainedIds.map(nameFor),
    lost: lostIds.map(nameFor),
    daily: dailyRows.map((r) => ({ d: r.d, receivers: Number(r.c) })),
  };

  // Redundancy / SPOF: how concentrated this node's path to the network is.
  const totalDirect = receivers.reduce((sum, r) => sum + r.count, 0);
  const topShare = totalDirect > 0 ? Math.max(...receivers.map((r) => r.count)) / totalDirect : null;
  const isSpof = receivers.length === 1;

  // Link margin + a plain-language grade (coverage + best-link headroom + reach).
  const bestMargin = receivers.reduce<number | null>((m, r) => (r.avg_snr != null ? Math.max(m ?? -Infinity, r.avg_snr - floor) : m), null);
  const maxKm = receivers.reduce((m, r) => (r.distance_km != null && r.distance_km > m ? r.distance_km : m), 0);
  const coverage = Math.min(50, receivers.length * 8);
  const signal = bestMargin == null ? 0 : Math.max(0, Math.min(35, (bestMargin / 12) * 35));
  const reachPts = Math.min(15, (maxKm / 20) * 15);
  const score = Math.round(coverage + signal + reachPts);
  const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F";
  const gradeReason =
    receivers.length === 0 ? "No station hears this node directly yet."
    : isSpof ? "Only one station hears it directly, so there is no backup path."
    : bestMargin != null && bestMargin < 3 ? `Heard by ${receivers.length} stations, but the best link is weak.`
    : `Heard directly by ${receivers.length} stations${maxKm ? ` out to ${maxKm.toFixed(0)} km` : ""}.`;

  const tips: string[] = [];
  if (receivers.length === 0) tips.push("No gateway hears this node directly - it is only reachable through relays. A higher or clearer antenna, or a gateway nearby, would put it on the map directly.");
  if (isSpof) tips.push("Only one station hears this node directly. If that station goes offline it drops off the map - more height or coverage would add a backup path.");
  if (bestMargin != null && bestMargin < 3) tips.push(`The strongest link sits close to the noise floor (about ${Math.max(0, bestMargin).toFixed(0)} dB of headroom). Try raising the antenna, moving it outside or away from metal, or fitting a better antenna.`);
  if (trend.prev_direct_receivers > receivers.length && trend.prev_direct_receivers > 0) tips.push(`Heard by fewer stations than the previous week (was ${trend.prev_direct_receivers}). Did something change - antenna, position, or a neighbouring gateway going offline?`);
  if (receivers.length >= 5 && bestMargin != null && bestMargin >= 6) tips.push(`Looking great - ${receivers.length} stations hear this node clearly.`);
  if (tips.length === 0) tips.push("Solid coverage. Keep an eye on the trend over the coming weeks to catch any drop early.");

  return {
    node: { node_id: node.node_id, long_name: node.long_name, short_name: node.short_name, role: node.role, lat: node.lat != null ? Number(node.lat) : null, lon: node.lon != null ? Number(node.lon) : null, first_seen_at: node.first_seen_at },
    window_days: d,
    summary: {
      direct_receivers: receivers.length,
      neighbor_degree: myDeg,
      degree_rank: rank,
      nodes_ranked: degRows.length,
      bidirectional_links: links.filter((l) => l.bidir).length,
      heard_relayed: Number(hr?.s ?? 0),
      max_distance_km: maxKm || null,
      top_gateway_share: topShare,
      is_spof: isSpof,
      modem_preset: node.modem_preset,
      demod_floor_db: floor,
      grade, grade_score: score, grade_reason: gradeReason,
    },
    trend, tips, receivers, relayers, links,
  };
}

// ---------------------------------------------------------------------------
// Fleet reach: one combined graph of ALL of a user's claimed nodes plus everyone that hears them or
// they hear, so an owner sees their whole footprint on one map instead of a reach tab per node.
// ---------------------------------------------------------------------------
export interface FleetReachNode { id: number; name: string | null; lat: number | null; lon: number | null; role: string | null; mine: boolean }
export interface FleetReachEdge { a: number; b: number; type: "direct" | "neighbor"; snr: number | null }
// A gateway that hears one or more fleet nodes ONLY via a relay (never at 0 hops) and is not already
// a direct/neighbor of any fleet node. `links` are the fleet node ids it relays for (for map lines).
export interface FleetReachRelay { id: number; name: string | null; lat: number | null; lon: number | null; count: number; links: number[] }
export interface FleetReachMine { id: number; name: string | null; role: string | null; lat: number | null; lon: number | null; direct_receivers: number; neighbors: number; max_reach_km: number | null; is_spof: boolean; best_margin: number | null }
export interface FleetReachSummary { nodes_claimed: number; nodes_mapped: number; unique_receivers: number; unique_neighbors: number; relay_receivers: number; total_links: number; max_reach_km: number | null; at_risk: number; best_margin: number | null }
export interface FleetReachTrend { prev_unique_receivers: number; gained: { id: number; name: string | null }[]; lost: { id: number; name: string | null }[]; daily: { d: string; receivers: number }[] }
export interface FleetReach { window_days: number; summary: FleetReachSummary; trend: FleetReachTrend; mine: FleetReachMine[]; nodes: FleetReachNode[]; edges: FleetReachEdge[]; relayers: FleetReachRelay[]; mapped: number; total: number }

export async function getFleetReach(myIds: number[], days = 7): Promise<FleetReach> {
  const d = clampLimit(days, 90, 7);
  const uniqMine = [...new Set(myIds.filter((x) => Number.isFinite(x) && x > 0).map((x) => x >>> 0))];
  const emptySummary: FleetReachSummary = { nodes_claimed: uniqMine.length, nodes_mapped: 0, unique_receivers: 0, unique_neighbors: 0, relay_receivers: 0, total_links: 0, max_reach_km: null, at_risk: 0, best_margin: null };
  const emptyTrend: FleetReachTrend = { prev_unique_receivers: 0, gained: [], lost: [], daily: [] };
  if (uniqMine.length === 0) return { window_days: d, summary: emptySummary, trend: emptyTrend, mine: [], nodes: [], edges: [], relayers: [], mapped: 0, total: 0 };
  const inList = uniqMine.join(",");

  // Direct receivers (gateways that heard my nodes at 0 hops) and NeighborInfo links, both directions.
  const dr = await query<{ mineId: number; other: number; snr: number | null }>(
    `SELECT l.node_id AS mineId, COALESCE(g.owner_node_id, l.gateway_id) AS other,
            l.snr_sum / NULLIF(l.direct_count + l.relayed_count + l.unknown_count, 0) AS snr
     FROM gateway_node_link l JOIN gateways g ON g.gateway_id = l.gateway_id
     WHERE l.node_id IN (${inList}) AND l.direct_count > 0 AND l.last_direct_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)`, [d]);
  const nout = await query<{ mineId: number; other: number; snr: number | null }>(
    `SELECT node_id AS mineId, neighbor_id AS other, snr FROM node_neighbor WHERE node_id IN (${inList}) AND updated_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)`, [d]);
  const nin = await query<{ mineId: number; other: number; snr: number | null }>(
    `SELECT neighbor_id AS mineId, node_id AS other, snr FROM node_neighbor WHERE neighbor_id IN (${inList}) AND updated_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)`, [d]);

  const edgeMap = new Map<string, FleetReachEdge>();
  const put = (a: number, b: number, type: "direct" | "neighbor", snr: number | null) => {
    if (!a || !b || a === b) return;
    const key = `${a}-${b}`;
    const cur = edgeMap.get(key);
    if (!cur) { edgeMap.set(key, { a, b, type, snr }); return; }
    if (type === "direct") cur.type = "direct";       // direct beats neighbor visually
    if (cur.snr == null && snr != null) cur.snr = snr;
  };
  for (const r of dr) put(r.mineId, r.other, "direct", r.snr != null ? Number(r.snr) : null);
  for (const r of nout) put(r.mineId, r.other, "neighbor", r.snr != null ? Number(r.snr) : null);
  for (const r of nin) put(r.mineId, r.other, "neighbor", r.snr != null ? Number(r.snr) : null);

  const ids = new Set<number>(uniqMine);
  for (const e of edgeMap.values()) ids.add(e.b);
  const meta = await query<{ node_id: number; long_name: string | null; short_name: string | null; role: string | null; modem_preset: string | null; lat: number | null; lon: number | null }>(
    `SELECT n.node_id, n.long_name, n.short_name, n.role, n.modem_preset, p.latitude AS lat, p.longitude AS lon
     FROM nodes n LEFT JOIN node_positions p ON p.node_id = n.node_id WHERE n.node_id IN (${[...ids].join(",")})`);
  const mm = new Map(meta.map((m) => [m.node_id, m]));
  const mineSet = new Set(uniqMine);
  const pos = (lat: number | null, lon: number | null) => (lat != null && lon != null && !(Number(lat) === 0 && Number(lon) === 0) ? { lat: Number(lat), lon: Number(lon) } : { lat: null, lon: null });
  const nodes: FleetReachNode[] = [...ids].map((id) => {
    const m = mm.get(id); const p = pos(m?.lat ?? null, m?.lon ?? null);
    return { id, name: m?.long_name ?? m?.short_name ?? null, lat: p.lat, lon: p.lon, role: m?.role ?? null, mine: mineSet.has(id) };
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = [...edgeMap.values()];

  // Relayed-by footprint (optional map layer): gateways that hear fleet nodes only via a relay and are
  // not already a direct/neighbor of any fleet node. Shows the reach a direct-only view misses (routers
  // especially). Distances are meaningless for a relayed reception (Rule 4), so we keep positions only.
  const known = new Set(nodes.map((n) => n.id));
  const relRows = await query<{ mineId: number; gw: number; count: number }>(
    `SELECT l.node_id AS mineId, COALESCE(g.owner_node_id, l.gateway_id) AS gw, l.relayed_count AS count
     FROM gateway_node_link l JOIN gateways g ON g.gateway_id = l.gateway_id
     WHERE l.node_id IN (${inList}) AND l.relayed_count > 0 AND l.direct_count = 0
       AND l.last_relayed_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)`, [d]);
  const relAgg = new Map<number, { count: number; links: Set<number> }>();
  for (const r of relRows) {
    if (known.has(r.gw) || mineSet.has(r.gw)) continue; // already a direct/neighbor or one of ours
    const e = relAgg.get(r.gw) ?? { count: 0, links: new Set<number>() };
    e.count += Number(r.count); e.links.add(r.mineId); relAgg.set(r.gw, e);
  }
  let relayers: FleetReachRelay[] = [];
  if (relAgg.size) {
    const rids = [...relAgg.keys()];
    const rmeta = await query<{ node_id: number; long_name: string | null; short_name: string | null; lat: number | null; lon: number | null }>(
      `SELECT n.node_id, n.long_name, n.short_name, p.latitude AS lat, p.longitude AS lon
       FROM nodes n LEFT JOIN node_positions p ON p.node_id = n.node_id WHERE n.node_id IN (${rids.join(",")})`);
    const rmm = new Map(rmeta.map((m) => [m.node_id, m]));
    relayers = rids.map((id) => {
      const m = rmm.get(id); const p = pos(m?.lat ?? null, m?.lon ?? null); const agg = relAgg.get(id)!;
      return { id, name: m?.long_name ?? m?.short_name ?? null, lat: p.lat, lon: p.lon, count: agg.count, links: [...agg.links] };
    }).sort((a, b) => b.count - a.count);
  }

  const mine: FleetReachMine[] = uniqMine.map((id) => {
    const n = nodeById.get(id);
    const es = edges.filter((e) => e.a === id);
    const directs = es.filter((e) => e.type === "direct");
    const floor = DEMOD_FLOOR_DB[(mm.get(id)?.modem_preset ?? "").toUpperCase()] ?? -17.5;
    let maxKm: number | null = null, bestMargin: number | null = null;
    for (const e of directs) {
      const r = nodeById.get(e.b);
      if (n?.lat != null && n.lon != null && r?.lat != null && r.lon != null) {
        const km = haversineKm({ lat: n.lat, lon: n.lon }, { lat: r.lat, lon: r.lon });
        if (km <= 400 && (maxKm == null || km > maxKm)) maxKm = km;
      }
      if (e.snr != null) { const m = e.snr - floor; if (bestMargin == null || m > bestMargin) bestMargin = m; }
    }
    return {
      id, name: n?.name ?? null, role: n?.role ?? null, lat: n?.lat ?? null, lon: n?.lon ?? null,
      direct_receivers: directs.length, neighbors: es.filter((e) => e.type === "neighbor").length,
      max_reach_km: maxKm, is_spof: directs.length === 1, best_margin: bestMargin,
    };
  }).sort((a, b) => b.direct_receivers - a.direct_receivers);

  const summary: FleetReachSummary = {
    nodes_claimed: uniqMine.length,
    nodes_mapped: uniqMine.filter((id) => nodeById.get(id)?.lat != null).length,
    unique_receivers: new Set(edges.filter((e) => e.type === "direct").map((e) => e.b)).size,
    unique_neighbors: new Set(edges.filter((e) => e.type === "neighbor").map((e) => e.b)).size,
    relay_receivers: relayers.length,
    total_links: edges.length,
    max_reach_km: mine.reduce((m, r) => (r.max_reach_km != null && r.max_reach_km > m ? r.max_reach_km : m), 0) || null,
    at_risk: mine.filter((r) => r.direct_receivers <= 1).length,
    best_margin: mine.reduce<number | null>((m, r) => (r.best_margin != null ? Math.max(m ?? -Infinity, r.best_margin) : m), null),
  };

  // Fleet trend: unique direct-receiving gateways across ALL my nodes, this window vs the previous
  // one (gained/lost), plus a daily sparkline. From the hourly rollup, fleet-deduped by gateway.
  const trendRows = await query<{ gateway_id: number; cur: number; prev: number }>(
    `SELECT gateway_id,
            SUM(CASE WHEN bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? DAY) THEN direct_count ELSE 0 END) cur,
            SUM(CASE WHEN bucket_start <  (UTC_TIMESTAMP() - INTERVAL ? DAY) THEN direct_count ELSE 0 END) prev
     FROM reception_rollup_hour
     WHERE node_id IN (${inList}) AND direct_count > 0 AND bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     GROUP BY gateway_id`, [d, d, d * 2]);
  const curSet = new Set(trendRows.filter((r) => Number(r.cur) > 0).map((r) => r.gateway_id));
  const prevSet = new Set(trendRows.filter((r) => Number(r.prev) > 0).map((r) => r.gateway_id));
  const gainedIds = [...curSet].filter((g) => !prevSet.has(g));
  const lostIds = [...prevSet].filter((g) => !curSet.has(g));
  const chNames = new Map<number, string | null>();
  const chIds = [...new Set([...gainedIds, ...lostIds])];
  if (chIds.length) {
    const nm = await query<{ node_id: number; long_name: string | null; short_name: string | null }>(
      `SELECT node_id, long_name, short_name FROM nodes WHERE node_id IN (${chIds.join(",")})`);
    for (const m of nm) chNames.set(m.node_id, m.long_name ?? m.short_name ?? null);
  }
  const dailyRows = await query<{ d: string; c: number }>(
    `SELECT DATE(bucket_start) d, COUNT(DISTINCT gateway_id) c FROM reception_rollup_hour
     WHERE node_id IN (${inList}) AND direct_count > 0 AND bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     GROUP BY DATE(bucket_start) ORDER BY d`, [d * 2]);
  const trend: FleetReachTrend = {
    prev_unique_receivers: prevSet.size,
    gained: gainedIds.map((id) => ({ id, name: chNames.get(id) ?? null })),
    lost: lostIds.map((id) => ({ id, name: chNames.get(id) ?? null })),
    daily: dailyRows.map((r) => ({ d: r.d, receivers: Number(r.c) })),
  };

  return { window_days: d, summary, trend, mine, nodes, edges, relayers, mapped: nodes.filter((n) => n.lat != null).length, total: nodes.length };
}

export interface GraphNode { id: number; name: string | null; short: string | null; role: string | null; is_gateway: number; degree: number; mqtt_only: number }
export interface GraphEdge { a: number; b: number; type: "direct" | "relayed" | "traceroute" | "neighbor" }

// Mesh topology graph: RF adjacency from direct/relayed reception links plus
// traceroute hops, within a time window. Bounded for the force-directed view.
export async function getGraphData(opts: { hours?: number; relayed?: boolean; traceroute?: boolean; center?: number; depth?: number } = {}): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const hours = clampLimit(opts.hours ?? 24, 24 * 90, 24);
  const EDGE_CAP = 6000;
  const edgeMap = new Map<string, GraphEdge>();
  const rank = { traceroute: 0, relayed: 1, neighbor: 2, direct: 3 };
  const add = (a: number, b: number, type: GraphEdge["type"]) => {
    if (!a || !b || a === b) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}-${hi}`;
    const cur = edgeMap.get(key);
    if (!cur || rank[type] > rank[cur.type]) edgeMap.set(key, { a: lo, b: hi, type });
  };

  const direct = await query<{ gateway_id: number; node_id: number }>(
    `SELECT gateway_id, node_id FROM gateway_node_link
     WHERE direct_count > 0 AND last_direct_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
     LIMIT ${EDGE_CAP}`,
    [hours],
  );
  for (const d of direct) add(d.gateway_id, d.node_id, "direct");

  // NeighborInfo-reported RF adjacency (true node-to-node links).
  const nbr = await query<{ node_id: number; neighbor_id: number }>(
    `SELECT node_id, neighbor_id FROM node_neighbor
     WHERE updated_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) LIMIT ${EDGE_CAP}`,
    [hours],
  );
  for (const n of nbr) add(n.node_id, n.neighbor_id, "neighbor");

  if (opts.relayed) {
    const rel = await query<{ gateway_id: number; node_id: number }>(
      `SELECT gateway_id, node_id FROM gateway_node_link
       WHERE relayed_count > 0 AND last_relayed_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
       LIMIT ${EDGE_CAP}`,
      [hours],
    );
    for (const r of rel) add(r.gateway_id, r.node_id, "relayed");
  }

  if (opts.traceroute !== false) {
    const tr = await query<{ route: string | null; from_node_id: number; to_node_id: number }>(
      `SELECT route, from_node_id, to_node_id FROM link_events
       WHERE route IS NOT NULL AND observed_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
       ORDER BY observed_at DESC LIMIT 3000`,
      [hours],
    );
    for (const t of tr) {
      let path: number[] = [];
      try {
        path = [t.from_node_id, ...(JSON.parse(t.route ?? "[]") as number[]), t.to_node_id];
      } catch {
        continue;
      }
      for (let i = 1; i < path.length; i++) add(path[i - 1]!, path[i]!, "traceroute");
    }
  }

  let edges = [...edgeMap.values()].slice(0, EDGE_CAP);

  // Ego mode: keep only the subgraph within `depth` hops of `center` (for the node-page
  // "nodes directly around it" view). BFS over the full edge adjacency, then keep edges whose
  // endpoints both survive.
  if (opts.center) {
    const adj = new Map<number, number[]>();
    for (const e of edges) {
      (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e.b);
      (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push(e.a);
    }
    const depth = Math.max(1, Math.min(opts.depth ?? 1, 4));
    const keep = new Set<number>([opts.center]);
    let frontier = [opts.center];
    for (let d = 0; d < depth; d++) {
      const next: number[] = [];
      for (const u of frontier) for (const v of adj.get(u) ?? []) if (!keep.has(v)) { keep.add(v); next.push(v); }
      frontier = next;
    }
    edges = edges.filter((e) => keep.has(e.a) && keep.has(e.b));
  }

  const ids = new Set<number>();
  const degree = new Map<number, number>();
  for (const e of edges) {
    ids.add(e.a);
    ids.add(e.b);
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  if (ids.size === 0) return { nodes: [], edges: [] };

  const idList = [...ids];
  const meta = await query<{ node_id: number; long_name: string | null; short_name: string | null; role: string | null; is_gateway: number }>(
    `SELECT node_id, long_name, short_name, role, is_gateway FROM nodes WHERE node_id IN (${idList.join(",")})`,
  );
  const metaMap = new Map(meta.map((m) => [m.node_id, m]));
  // Which of these nodes had any RF reception in the window (vs present only via MQTT). Lets the
  // graph offer a "hide MQTT-only" filter. One bounded aggregate over the id set, partition-pruned
  // by rx_time; the (from_node_id, rx_time) index keeps it to range scans.
  const rf = await query<{ node_id: number; rf: number }>(
    `SELECT from_node_id AS node_id, MAX(transport = 'rf') AS rf FROM receptions
     WHERE from_node_id IN (${idList.join(",")}) AND rx_time >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
     GROUP BY from_node_id`,
    [hours],
  );
  const hasRf = new Set(rf.filter((r) => Number(r.rf) > 0).map((r) => r.node_id));
  const nodes: GraphNode[] = idList.map((id) => {
    const m = metaMap.get(id);
    return { id, name: m?.long_name ?? null, short: m?.short_name ?? null, role: m?.role ?? null, is_gateway: m?.is_gateway ?? 0, degree: degree.get(id) ?? 0, mqtt_only: hasRf.has(id) ? 0 : 1 };
  });
  return { nodes, edges };
}

// --- Backbone / relay inventory (surfaces relay_nodes + mesh_link + neighbor degree) ---

export interface RelayRow { relay_byte: number; evidence_count: number; claimed_role: string | null; role_violation: number; last_seen_at: string | null; candidates: { id: number; name: string | null }[] }
export interface MeshLinkRow { a: number; b: number; a_name: string | null; b_name: string | null; times_seen: number; last_snr: number | null; last_seen_at: string }
export interface ConnRow { node_id: number; name: string | null; neighbors: number }

/** Most-active relay bytes (Meshtastic relays identify by the last byte of their node id, so
 * one byte can map to several candidate nodes). Resolves candidate node names. */
export async function topRelays(limit = 50): Promise<RelayRow[]> {
  const rows = await query<{ relay_node_byte: number; candidate_nodes: unknown; evidence_count: number; claimed_role: string | null; role_violation: number; last_seen_at: string | null }>(
    `SELECT relay_node_byte, candidate_nodes, evidence_count, claimed_role, role_violation, last_seen_at
     FROM relay_nodes ORDER BY evidence_count DESC LIMIT ${clampLimit(limit, 300)}`,
  );
  const parse = (v: unknown): number[] => {
    try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a.map((x) => Number(x) >>> 0) : []; } catch { return []; }
  };
  const relays = rows.map((r) => ({ ...r, ids: parse(r.candidate_nodes) }));
  const allIds = [...new Set(relays.flatMap((r) => r.ids))];
  const nameMap = new Map<number, string | null>();
  if (allIds.length) {
    const names = await query<{ node_id: number; long_name: string | null; short_name: string | null }>(
      `SELECT node_id, long_name, short_name FROM nodes WHERE node_id IN (${allIds.join(",")})`,
    );
    for (const n of names) nameMap.set(n.node_id, n.long_name ?? n.short_name ?? null);
  }
  return relays.map((r) => ({
    relay_byte: r.relay_node_byte,
    evidence_count: Number(r.evidence_count),
    claimed_role: r.claimed_role,
    role_violation: r.role_violation,
    last_seen_at: r.last_seen_at,
    candidates: r.ids.map((id) => ({ id, name: nameMap.get(id) ?? null })),
  }));
}

/** Most-observed node-to-node links (accumulated from traceroute hops). */
export async function strongestLinks(limit = 50): Promise<MeshLinkRow[]> {
  return query<MeshLinkRow>(
    `SELECT l.a_node_id AS a, l.b_node_id AS b,
            COALESCE(na.long_name, na.short_name) AS a_name, COALESCE(nb.long_name, nb.short_name) AS b_name,
            l.times_seen, l.last_snr, l.last_seen_at
     FROM mesh_link l
     LEFT JOIN nodes na ON na.node_id = l.a_node_id
     LEFT JOIN nodes nb ON nb.node_id = l.b_node_id
     ORDER BY l.times_seen DESC, l.last_seen_at DESC LIMIT ${clampLimit(limit, 300)}`,
  );
}

/** Nodes with the most RF neighbours (NeighborInfo degree), a proxy for backbone centrality. */
export async function mostConnectedNodes(limit = 30): Promise<ConnRow[]> {
  return query<ConnRow>(
    `SELECT nn.node_id, COALESCE(n.long_name, n.short_name) AS name, COUNT(DISTINCT nn.neighbor_id) AS neighbors
     FROM node_neighbor nn LEFT JOIN nodes n ON n.node_id = nn.node_id
     GROUP BY nn.node_id, n.long_name, n.short_name
     ORDER BY neighbors DESC LIMIT ${clampLimit(limit, 200)}`,
  );
}

/** Mesh-wide activity by hour-of-day x day-of-week (UTC buckets), for the activity clock. */
export async function meshActivityClock(days = 28): Promise<{ dow: number; hour: number; c: number }[]> {
  return query<{ dow: number; hour: number; c: number }>(
    `SELECT (DAYOFWEEK(bucket_start)-1) AS dow, HOUR(bucket_start) AS hour, SUM(reception_count) AS c
     FROM node_rollup_hour
     WHERE bucket_start >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
     GROUP BY dow, hour`,
    [days],
  );
}

export interface LeaderRow { node_id: number; name: string | null; short_name: string | null; value: number }

/** Nodes with the longest current uptime (latest uptime telemetry, last 7 days). */
export async function uptimeLeaders(limit = 15): Promise<LeaderRow[]> {
  return query<LeaderRow>(
    `SELECT t.node_id, COALESCE(n.long_name, n.short_name) AS name, n.short_name AS short_name, t.value AS value
     FROM node_telemetry t
     JOIN (SELECT node_id, MAX(observed_at) mo FROM node_telemetry
           WHERE metric='uptime' AND observed_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY) GROUP BY node_id) x
       ON x.node_id=t.node_id AND x.mo=t.observed_at
     LEFT JOIN nodes n ON n.node_id=t.node_id
     WHERE t.metric='uptime' AND t.observed_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)
     ORDER BY t.value DESC LIMIT ${clampLimit(limit, 100)}`,
  );
}

/** Highest-altitude nodes (real GPS altitude). */
export async function altitudeLeaders(limit = 15): Promise<LeaderRow[]> {
  return query<LeaderRow>(
    `SELECT p.node_id, COALESCE(n.long_name, n.short_name) AS name, n.short_name AS short_name, p.altitude_m AS value
     FROM node_positions p LEFT JOIN nodes n ON n.node_id=p.node_id
     WHERE p.altitude_m IS NOT NULL
     ORDER BY p.altitude_m DESC LIMIT ${clampLimit(limit, 100)}`,
  );
}

export async function hopDistribution(hours = 24): Promise<{ hops: number; c: number }[]> {
  // Bounded scan over recent RF receptions with computable hop counts.
  return query<{ hops: number; c: number }>(
    `SELECT (hop_start - hop_limit) AS hops, COUNT(*) AS c
     FROM receptions
     WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
       AND hop_start IS NOT NULL AND hop_limit IS NOT NULL
       AND reception_class IN ('rf_direct','rf_relayed')
     GROUP BY hops ORDER BY hops ASC`,
    [hours],
  );
}

// Histogram of confirmed direct-link distances (gateway<->node), bucketed. Returns fixed
// buckets 0..6 mapped to labels by the caller.
export async function distanceDistribution(): Promise<{ bkt: number; c: number }[]> {
  return query<{ bkt: number; c: number }>(
    `SELECT bkt, COUNT(*) AS c FROM (
       SELECT CASE WHEN d < 1 THEN 0 WHEN d < 2 THEN 1 WHEN d < 5 THEN 2 WHEN d < 10 THEN 3
                   WHEN d < 20 THEN 4 WHEN d < 50 THEN 5 ELSE 6 END AS bkt
       FROM (
         SELECT 6371 * ACOS(LEAST(1, COS(RADIANS(gp.latitude))*COS(RADIANS(np.latitude))*
                  COS(RADIANS(np.longitude)-RADIANS(gp.longitude)) +
                  SIN(RADIANS(gp.latitude))*SIN(RADIANS(np.latitude)))) AS d
         FROM gateway_node_link l
         JOIN node_positions gp ON gp.node_id = l.gateway_id
         JOIN node_positions np ON np.node_id = l.node_id
         JOIN nodes gwn ON gwn.node_id = l.gateway_id
         JOIN nodes nn ON nn.node_id = l.node_id
         WHERE l.direct_count > 0 AND gp.latitude IS NOT NULL AND np.latitude IS NOT NULL AND l.gateway_id <> l.node_id
           AND gwn.mute_hidden = 0 AND gwn.position_ignored = 0
           AND (nn.mute_hidden = 0 OR nn.mute_hidden IS NULL)
           AND (nn.position_ignored = 0 OR nn.position_ignored IS NULL)
       ) dd
       -- Cap and flag-filter as the DX records do: without them a single spoofed position put a
       -- 15000 km link in the top bucket, which is the whole histogram's headline.
       WHERE d <= 500
     ) b GROUP BY bkt ORDER BY bkt`,
  );
}

export interface KeyVerificationRow {
  nonce: string; first_at: string; last_at: string; stages: string;
  initiator: number; initiator_name: string | null; peer: number | null; peer_name: string | null;
  completed: number;
}

/**
 * PKI key-verification handshakes, one row per nonce.
 *
 * The nonce is the correlator the requester picks, so grouping by it reconstructs each exchange. A
 * handshake that never reached the `final` stage is abandoned or failed, which is the point of
 * surfacing this at all: a verification that quietly did not complete leaves two operators believing
 * they have verified each other.
 */
export async function listKeyVerifications(limit = 100): Promise<KeyVerificationRow[]> {
  return query<KeyVerificationRow>(
    `SELECT k.nonce,
            MIN(k.observed_at) first_at, MAX(k.observed_at) last_at,
            GROUP_CONCAT(DISTINCT k.stage ORDER BY k.stage) stages,
            MAX(CASE WHEN k.stage='final' THEN 1 ELSE 0 END) completed,
            SUBSTRING_INDEX(GROUP_CONCAT(k.from_node_id ORDER BY k.observed_at ASC), ',', 1) + 0 AS initiator,
            NULL AS initiator_name,
            SUBSTRING_INDEX(GROUP_CONCAT(k.to_node_id ORDER BY k.observed_at ASC), ',', 1) + 0 AS peer,
            NULL AS peer_name
     FROM key_verification k
     WHERE k.observed_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY)
     GROUP BY k.nonce
     ORDER BY last_at DESC LIMIT ${clampLimit(limit, 500, 100)}`,
  );
}

export interface SensorEventRow {
  id: number; node_id: number; kind: string; body: string; channel_id: string | null;
  observed_at: string; long_name: string | null; short_name: string | null;
}

/**
 * DETECTION_SENSOR_APP / ALERT_APP events, newest first.
 *
 * These are the physical-world event stream (the firmware's DetectionSensorModule: door opened,
 * motion, water level) and the mesh's critical-alert broadcasts. Both were decoded to a port number
 * and then discarded. Deliberately separate from text_message so they are not chat.
 */
export async function listSensorEvents(opts: { kind?: string; nodeId?: number; limit?: number } = {}): Promise<SensorEventRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.kind === "detection" || opts.kind === "alert") { where.push("s.kind = ?"); params.push(opts.kind); }
  if (opts.nodeId) { where.push("s.node_id = ?"); params.push(opts.nodeId); }
  return query<SensorEventRow>(
    `SELECT s.id, s.node_id, s.kind, s.body, s.channel_id, s.observed_at, n.long_name, n.short_name
     FROM sensor_event s LEFT JOIN nodes n ON n.node_id = s.node_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY s.observed_at DESC LIMIT ${clampLimit(opts.limit, 500, 100)}`,
    params,
  );
}

export interface LowBatteryRow {
  node_id: number; long_name: string | null; short_name: string | null; role: string | null;
  is_gateway: number; battery: number; voltage: number | null; last_seen_at: string | null;
  observed_at: string; projected_dead_at: string | null;
}

/** All nodes whose latest battery reading is at or below `threshold` percent, lowest first. */
export async function lowBatteryNodes(threshold = 35, limit = 200): Promise<LowBatteryRow[]> {
  return query<LowBatteryRow>(
    `SELECT n.node_id, n.long_name, n.short_name, n.role, n.is_gateway, n.last_seen_at,
            b.battery, b.observed_at, bf.current_voltage AS voltage, bf.projected_dead_at
     FROM nodes n
     JOIN (
       SELECT t.node_id, t.value AS battery, t.observed_at
       FROM node_telemetry t
       JOIN (SELECT node_id, MAX(observed_at) mo FROM node_telemetry WHERE metric='battery_pct' AND observed_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY) GROUP BY node_id) x
         ON x.node_id = t.node_id AND t.observed_at = x.mo AND t.metric = 'battery_pct'
     ) b ON b.node_id = n.node_id
     LEFT JOIN battery_forecast bf ON bf.node_id = n.node_id
     WHERE b.battery <= ? AND (n.mute_hidden = 0 OR n.mute_hidden IS NULL)
     ORDER BY b.battery ASC, n.last_seen_at DESC
     LIMIT ${clampLimit(limit, 500)}`,
    [Math.min(100, Math.max(0, threshold))],
  );
}

export interface LosEndpoint { node_id: number; name: string | null; latitude: number; longitude: number; rf_height_m: number | null }

/** A node's position + antenna height for the line-of-sight tool, or null if unpositioned. */
export async function getLosEndpoint(nodeId: number): Promise<LosEndpoint | null> {
  const rows = await query<LosEndpoint>(
    `SELECT n.node_id, COALESCE(n.long_name, n.short_name) AS name, p.latitude, p.longitude, n.rf_height_m
     FROM node_positions p JOIN nodes n ON n.node_id = p.node_id
     WHERE n.node_id = ? AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL LIMIT 1`,
    [nodeId],
  );
  return rows[0] ?? null;
}

/** Positioned nodes for the line-of-sight pickers. */
export async function listPositionedNodes(): Promise<{ node_id: number; name: string | null }[]> {
  return query<{ node_id: number; name: string | null }>(
    `SELECT n.node_id, COALESCE(n.long_name, n.short_name) AS name
     FROM node_positions p JOIN nodes n ON n.node_id = p.node_id
     WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
       AND (n.position_ignored = 0 OR n.position_ignored IS NULL)
     ORDER BY name IS NULL, name`,
  );
}

export interface Distributions {
  nodeActivity: { bkt: number; c: number }[];    // nodes bucketed by packets sent (24h)
  gatewayActivity: { bkt: number; c: number }[];  // gateways bucketed by receptions (24h)
  signalQuality: { bkt: number; c: number }[];     // direct receptions bucketed by RSSI (24h)
  routing: { rc: string; c: number }[];            // receptions by class (24h)
  protocol: { port_num: number; c: number }[];     // packets by portnum (24h)
}

/** Five 24h distributions for the distributions dashboard. Bucket indices are mapped to
 *  labels by the page; all windows are the trailing 24 hours. */
export async function getDistributions(): Promise<Distributions> {
  const [nodeActivity, gatewayActivity, signalQuality, routing, protocol] = await Promise.all([
    query<{ bkt: number; c: number }>(
      `SELECT CASE WHEN c<=10 THEN 0 WHEN c<=50 THEN 1 WHEN c<=200 THEN 2 WHEN c<=1000 THEN 3 ELSE 4 END bkt, COUNT(*) c
       FROM (SELECT from_node_id, COUNT(*) c FROM packets WHERE first_seen_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR GROUP BY from_node_id) x
       GROUP BY bkt ORDER BY bkt`,
    ),
    query<{ bkt: number; c: number }>(
      `SELECT CASE WHEN c<=100 THEN 0 WHEN c<=1000 THEN 1 WHEN c<=5000 THEN 2 WHEN c<=20000 THEN 3 ELSE 4 END bkt, COUNT(*) c
       FROM (SELECT gateway_id, COUNT(*) c FROM receptions WHERE rx_time >= UTC_TIMESTAMP() - INTERVAL 24 HOUR GROUP BY gateway_id) x
       GROUP BY bkt ORDER BY bkt`,
    ),
    query<{ bkt: number; c: number }>(
      `SELECT CASE WHEN rx_rssi >= -80 THEN 0 WHEN rx_rssi >= -95 THEN 1 WHEN rx_rssi >= -105 THEN 2 WHEN rx_rssi >= -115 THEN 3 ELSE 4 END bkt, COUNT(*) c
       FROM receptions WHERE rx_time >= UTC_TIMESTAMP() - INTERVAL 24 HOUR AND rx_rssi IS NOT NULL AND reception_class='rf_direct'
       GROUP BY bkt ORDER BY bkt`,
    ),
    query<{ rc: string; c: number }>(
      `SELECT reception_class rc, COUNT(*) c FROM receptions WHERE rx_time >= UTC_TIMESTAMP() - INTERVAL 24 HOUR GROUP BY reception_class ORDER BY c DESC`,
    ),
    query<{ port_num: number; c: number }>(
      `SELECT COALESCE(port_num, 0) port_num, COUNT(*) c FROM packets WHERE first_seen_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR GROUP BY port_num ORDER BY c DESC LIMIT 20`,
    ),
  ]);
  return { nodeActivity, gatewayActivity, signalQuality, routing, protocol };
}

export interface HealthData {
  brokers: BrokerHealthRow[];
  ingestLagSeconds: number | null;
  topics: { topic_path: string; broker_id: string; valid_count: number; malformed_count: number; last_error: string | null }[];
  rollupWatermarkAgeSeconds: number | null;
}

export async function getHealth(): Promise<HealthData> {
  const brokers = await query<BrokerHealthRow>(`SELECT * FROM broker_health ORDER BY broker_id`);
  const [lag] = await query<{ s: number | null }>(
    `SELECT AVG(ingest_lag_ms)/1000 s FROM receptions WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL 5 MINUTE)`,
  );
  const topics = await query<HealthData["topics"][number]>(
    `SELECT topic_path, broker_id, valid_count, malformed_count, last_error
     FROM packet_topics ORDER BY malformed_count DESC, valid_count DESC LIMIT 50`,
  );
  const [wm] = await query<{ s: number | null }>(
    `SELECT TIMESTAMPDIFF(SECOND, last_bucket_folded, UTC_TIMESTAMP()) s
     FROM rollup_watermark WHERE rollup_name='hourly'`,
  );
  return {
    brokers,
    ingestLagSeconds: lag?.s === null || lag?.s === undefined ? null : Number(lag.s),
    topics,
    rollupWatermarkAgeSeconds: wm?.s === null || wm?.s === undefined ? null : Number(wm.s),
  };
}

export interface SelfTestSignalRows {
  brokersTotal: number; brokersConnected: number;
  lastReceptionAgeSec: number | null; rollupWatermarkAgeSec: number | null; healthAgeMin: number | null;
  weatherAgeMin: number | null; spaceWeatherAgeMin: number | null;
}

/** DB-side signals for the /health self-test panel. Enable-flags are layered on from config. */
export async function getSelfTestSignals(): Promise<SelfTestSignalRows> {
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const [brokers] = await query<{ total: number; connected: number }>(
    `SELECT COUNT(*) total, SUM(connected=1) connected FROM broker_health`,
  );
  // Bounded to the last day so partition pruning keeps this cheap on huge reception tables.
  const [rx] = await query<{ s: number | null }>(
    `SELECT TIMESTAMPDIFF(SECOND, MAX(rx_time), UTC_TIMESTAMP()) s FROM receptions WHERE rx_time >= UTC_TIMESTAMP() - INTERVAL 1 DAY`,
  );
  const [wm] = await query<{ s: number | null }>(
    `SELECT TIMESTAMPDIFF(SECOND, last_bucket_folded, UTC_TIMESTAMP()) s FROM rollup_watermark WHERE rollup_name='hourly'`,
  );
  const [hb] = await query<{ m: number | null }>(
    `SELECT TIMESTAMPDIFF(SECOND, computed_at, UTC_TIMESTAMP())/60 m FROM health_snapshot WHERE id=1`,
  );
  const [wx] = await query<{ m: number | null }>(`SELECT TIMESTAMPDIFF(MINUTE, MAX(observed_at), UTC_TIMESTAMP()) m FROM weather_obs`);
  const [sw] = await query<{ m: number | null }>(`SELECT TIMESTAMPDIFF(MINUTE, MAX(fetched_at), UTC_TIMESTAMP()) m FROM space_weather_obs`);
  return {
    brokersTotal: Number(brokers?.total ?? 0),
    brokersConnected: Number(brokers?.connected ?? 0),
    lastReceptionAgeSec: n(rx?.s),
    rollupWatermarkAgeSec: n(wm?.s),
    healthAgeMin: n(hb?.m),
    weatherAgeMin: n(wx?.m),
    spaceWeatherAgeMin: n(sw?.m),
  };
}
