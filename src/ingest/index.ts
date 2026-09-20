// HopWatch ingest daemon. Separate process; talks to the web/worker only via MySQL.
//   1. run migrations (idempotent)
//   2. load brokers + channel keys from the DB (seeded from config on first run)
//   3. connect every enabled broker; decode -> dedup -> persist each message
//   4. hot-reload connectors when the admin edits settings in the UI
//   5. track per-topic decode health + per-broker connection health
import { loadConfig } from "../config/load.ts";
import { effectiveConfig } from "../db/appsettings.ts";
import { ensurePartitions } from "../db/partitions.ts";
import { getPool, closePool } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { parseTopic } from "../meshtastic/topic.ts";
import { decodeProtobufEnvelope, decodeJsonEnvelope, DecodeError, type ChannelKey } from "../meshtastic/decode.ts";
import type { NormalizedEnvelope } from "../meshtastic/types.ts";
import { seedIngestConfig, getRuntimeBrokers, getChannelKeys, configFingerprint } from "../db/settings.ts";
import { secretDecryptFailures } from "../lib/secrets.ts";
import { installRestartWatcher } from "../lib/servicecontrol.ts";
import { DedupCache, fidelityRank, RANK_RF } from "./dedup.ts";
import { BatchIngestor } from "./batch.ts";
import { BrokerConnector } from "./broker.ts";
import { NodeRxConnector } from "./nodeConnector.ts";
import { flushMqttClients } from "./mqttclients.ts";

const TEXT_PORT = 1; // TEXT_MESSAGE_APP

/** Rewrite an incoming Meshtastic MQTT topic onto a destination broker's root, keeping the
 * `2/e/<channel>/<gateway>` suffix, so the destination's subscribers receive the bridged
 * message. Falls back to the original topic if either root cannot be determined. */
function rewriteTopic(srcTopic: string, destRoot: string): string {
  if (!destRoot) return srcTopic;
  const i = srcTopic.indexOf("/2/");
  if (i < 0) return srcTopic;
  return `${destRoot}${srcTopic.slice(i)}`;
}
type BridgeCfg = { enabled: boolean; armed: boolean; text_only: boolean; require_ok_to_mqtt: boolean; direction: "both" | "out" | "in"; channels: string[]; local_broker_id: string; peer_broker_ids: string[] };

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log("[ingest] starting");
  await runMigrations();
  installRestartWatcher("ingest");
  await seedIngestConfig(cfg); // first run copies config brokers/keys into the DB

  // Pre-create the write-target partitions here too, not only in the worker: if the worker is down
  // longer than precreate_ahead_days while ingest keeps writing, new rows would pile into pmax and
  // the next REORGANIZE would be a slow full rewrite. Best-effort; the worker still owns retention.
  try {
    const eff = await effectiveConfig();
    const ahead = eff.database.partitioning.precreate_ahead_days;
    for (const t of ["packets", "receptions", "packet_payloads", "node_telemetry"] as const) {
      await ensurePartitions(t, ahead);
    }
  } catch (e) {
    console.error(`[ingest] partition pre-create skipped: ${(e as Error).message}`);
  }

  // Runtime knobs come from effectiveConfig (file config + admin overrides) and hot-reload in
  // reload(); the file config is only the first-run seed. Rule 1: never consume loadConfig here.
  let window = cfg.ingest.idempotency_window_seconds;
  const dedup = new DedupCache(window * 1000);
  let tolerate = cfg.ingest.decode.tolerate_malformed;
  const batch = new BatchIngestor();

  let connectors: BrokerConnector[] = [];
  let nodeRx: NodeRxConnector | null = null; // station-node RF receive (transport=rf)
  let keys: ChannelKey[] = [];
  let lastFingerprint = -1;
  let lastBrokerSig = "";
  let bridge: BridgeCfg | null = null;
  // Loop guard for the bridge: forward a given (from:packetId) at most once per window.
  const bridgeSeen = new DedupCache(5 * 60 * 1000);

  // Forward a decoded text message between the local broker and peers, gated by OK-to-MQTT.
  const maybeBridge = (env: NormalizedEnvelope, topic: string, payload: Buffer, brokerId: string): void => {
    const b = bridge;
    if (!b || !b.enabled || !b.armed || !b.local_broker_id) return;
    if (b.text_only && env.packet.decoded?.portnum !== TEXT_PORT) return;
    if (b.require_ok_to_mqtt && !env.packet.okToMqtt) return;
    if (b.channels.length > 0 && !b.channels.includes(env.channelId)) return; // channel allowlist
    if (env.packet.meshPacketId === 0) return; // cannot dedup id-less packets; skip to avoid loops
    let dests: BrokerConnector[]; let direction: "out" | "in";
    if (brokerId === b.local_broker_id) {
      if (b.direction === "in") return; // outbound disabled
      dests = connectors.filter((c) => b.peer_broker_ids.includes(c.id)); direction = "out";
    } else if (b.peer_broker_ids.includes(brokerId)) {
      if (b.direction === "out") return; // inbound disabled
      dests = connectors.filter((c) => c.id === b.local_broker_id); direction = "in";
    } else return; // not part of the bridge (never peer-to-peer)
    if (dests.length === 0) return;
    // Dedup only once we know it is bridgeable, so a filtered packet does not block a later one.
    if (bridgeSeen.seen(`${env.packet.from}:${env.packet.meshPacketId}`, Date.now())) return;
    // One log row per destination so the source -> destination topic mapping is verifiable.
    for (const d of dests) {
      const destTopic = rewriteTopic(topic, d.topicRoot);
      d.publish(destTopic, payload);
      void logBridge(direction, brokerId, d.id, env.packet.from, env.packet.meshPacketId, env.channelId, topic, destTopic);
    }
  };

  const makeHandler = (brokerId: string, get: () => BrokerConnector | undefined) => async (topic: string, payload: Buffer) => {
    const info = parseTopic(topic);
    try {
      let env;
      if (info.isJson) {
        env = decodeJsonEnvelope(JSON.parse(payload.toString("utf8")), info);
      } else if (info.isMap) {
        // The `/2/map/` topic carries a full ServiceEnvelope whose MeshPacket holds a DECODED
        // MapReport on MAP_REPORT_APP (port 73), so it goes through the normal protobuf path;
        // no channel key is involved. It is the only passive source of firmware_version.
        env = await decodeProtobufEnvelope(new Uint8Array(payload), info, keys);
      } else {
        env = await decodeProtobufEnvelope(new Uint8Array(payload), info, keys);
      }
      // Skip dedup for id-less packets (0): we cannot distinguish distinct ones, and
      // deduping would collapse most traffic to one per window.
      if (env.packet.meshPacketId !== 0) {
        const key = `${env.packet.from}:${env.packet.meshPacketId}:${env.gatewayId}`;
        // A broker subscribed to a subtree (the seeded `msh/#`) receives BOTH the protobuf and the
        // JSON publication of the same packet, producing this identical key. The JSON decode path
        // is synchronous while the protobuf path awaits, so JSON reliably claimed the key first and
        // the richer copy was dropped whole: no ok_to_mqtt (so the bridge forwarded nothing), no
        // relay_node, and no traceroute/neighborinfo parse. Ranking lets protobuf supersede JSON
        // once, while repeat deliveries of the same format still collapse.
        if (dedup.seen(key, Date.now(), fidelityRank(env.fromJson))) return;
      }
      batch.enqueue(env, { brokerId, rawTopic: topic, windowSeconds: window });
      maybeBridge(env, topic, payload, brokerId);
      recordTopic(topic, brokerId, true);
    } catch (e) {
      get()?.countMalformed();
      recordTopic(topic, brokerId, false, (e as Error).message);
      if (!(e instanceof DecodeError) && !tolerate) throw e;
    }
  };

  // RF receptions from the station node flow through the same pipeline as MQTT, tagged
  // transport=rf, deduped the same way. brokerId "node" makes the RF source distinguishable in
  // the existing per-broker views alongside the precise receptions.transport designation.
  const onNodePacket = async (env: NormalizedEnvelope): Promise<void> => {
    if (env.packet.meshPacketId !== 0) {
      const now = Date.now();
      const key = `${env.packet.from}:${env.packet.meshPacketId}:${env.gatewayId}`;
      // RF is authoritative: dedup RF-vs-RF only, so an MQTT echo can never suppress the direct
      // RF copy. Then mark the shared key so the node's later MQTT uplink of this same reception
      // is suppressed by makeHandler (the pipeline also upgrades any existing row to transport=rf).
      if (dedup.seen(`rf:${key}`, now, RANK_RF)) return;
      // RANK_RF is the top rank, so this claim cannot be superseded: without it the node's own
      // protobuf MQTT echo would outrank the shared claim and be ingested as a second copy.
      dedup.seen(key, now, RANK_RF);
    }
    batch.enqueue(env, { brokerId: "node", rawTopic: "rf", windowSeconds: window, transport: "rf" });
  };

    // Only broker connection parameters require a connector restart. Channel keys, the idempotency
    // window, tolerate-malformed, and the bridge config are all read live via closures, so they are
    // refreshed in place without dropping any MQTT connection (dropping one at QoS 0 loses every
    // message in the reconnect gap). We reconnect brokers only when their config signature changes.
  async function reload(): Promise<void> {
    keys = await getChannelKeys();
    let nodeCfg: { host: string; port: number; rx_enabled: boolean } | null = null;
    try {
      const eff = await effectiveConfig();
      bridge = eff.bridge as BridgeCfg;
      window = eff.ingest.idempotency_window_seconds;
      tolerate = eff.ingest.decode.tolerate_malformed;
      dedup.setTtl(window * 1000);
      nodeCfg = eff.node as { host: string; port: number; rx_enabled: boolean };
    } catch { bridge = null; }
    const brokers = await getRuntimeBrokers();
    const brokerSig = JSON.stringify(brokers);
    if (brokerSig !== lastBrokerSig) {
      lastBrokerSig = brokerSig;
      await Promise.all(connectors.map((c) => c.stop()));
      connectors = [];
      for (const brokerCfg of brokers) {
        let self: BrokerConnector;
        const connector = new BrokerConnector(brokerCfg, makeHandler(brokerCfg.id, () => self));
        self = connector;
        connector.start();
        connectors.push(connector);
      }
      console.log(`[ingest] broker connections (re)started (${brokers.length})`);
    }
    // Station-node RF receive: start/stop/reconnect based on config. Recreate on host/port change.
    const wantRx = !!(nodeCfg && nodeCfg.host && nodeCfg.rx_enabled);
    if (wantRx && (!nodeRx || nodeRx.host !== nodeCfg!.host || nodeRx.port !== nodeCfg!.port)) {
      if (nodeRx) await nodeRx.stop();
      nodeRx = new NodeRxConnector(nodeCfg!.host, nodeCfg!.port, () => keys, onNodePacket);
      nodeRx.start();
    } else if (!wantRx && nodeRx) {
      await nodeRx.stop();
      nodeRx = null;
    }
    // Name any secret the master key could not decrypt. Those read as unset rather than throwing
    // (a throw here used to exit the daemon into a systemd restart loop), so without this line the
    // symptom would be silent: a broker that will not authenticate, or a channel that decodes nothing.
    const badSecrets = secretDecryptFailures();
    console.log(`[ingest] active brokers: ${brokers.map((b) => b.id).join(", ") || "(none configured)"}; ${keys.length} channel key(s); RF node: ${wantRx ? nodeCfg!.host : "off"}${badSecrets.length ? `; ${badSecrets.length} UNREADABLE secret(s): ${badSecrets.join(", ")} (master key changed? re-enter in /admin/settings)` : ""}`);
  }

  await reload();
  try {
    lastFingerprint = await configFingerprint();
  } catch (e) {
    console.error(`[ingest] settings revision unavailable (run migrations?): ${(e as Error).message}`);
    lastFingerprint = -1;
  }

  // Poll for admin edits and hot-reload connectors when settings change.
  const reloadTimer = setInterval(() => {
    void (async () => {
      try {
        const fp = await configFingerprint();
        if (fp !== lastFingerprint) {
          lastFingerprint = fp;
          console.log("[ingest] settings changed; reloading brokers");
          await reload();
        }
      } catch (e) {
        console.error(`[ingest] reload check failed: ${(e as Error).message}`);
      }
    })();
  }, 5_000);

  // Periodic broker-health flush to the DB (surfaced on the health page + /metrics). The RF node
  // reports into the same table under broker_id "node" so the web process can show its state.
  const healthTimer = setInterval(() => { flushHealth(connectors).catch(() => {}); flushBrokerSys(connectors).catch(() => {}); flushMqttClients(connectors).catch(() => {}); flushNodeHealth(nodeRx).catch(() => {}); void flushTopics(); }, 15_000);

  const shutdown = async () => {
    console.log("[ingest] shutting down…");
    clearInterval(reloadTimer);
    clearInterval(healthTimer);
    await Promise.all(connectors.map((c) => c.stop()));
    if (nodeRx) await nodeRx.stop();
    // drain(), not flush(): flush() returns immediately when one is already in flight, so shutdown
    // used to skip the queue entirely and then close the pool underneath the still-running loop,
    // logging every remaining item as "dropped message". MQTT is QoS 0, so there is no redelivery.
    await batch.drain().catch(() => {});
    await flushTopics().catch(() => {});
    await flushHealth(connectors).catch(() => {});
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Per-topic valid/malformed counters are accumulated in memory and flushed in bulk on the health
// timer, instead of one DB upsert per message. A regional flood otherwise fired hundreds of
// concurrent single-row upserts (all contending on the same packet_topics rows, saturating the
// pool the batch flush also needs). recordTopic is synchronous and off the DB path.
interface TopicAgg { brokerId: string; topic: string; valid: number; malformed: number; lastErr: string | null; lastSeenMs: number }
const topicAgg = new Map<string, TopicAgg>();

function recordTopic(topic: string, brokerId: string, ok: boolean, err?: string): void {
  const t = topic.slice(0, 255);
  const key = `${brokerId}\t${t}`;
  let a = topicAgg.get(key);
  if (!a) { a = { brokerId, topic: t, valid: 0, malformed: 0, lastErr: null, lastSeenMs: 0 }; topicAgg.set(key, a); }
  if (ok) a.valid++;
  else { a.malformed++; if (err) a.lastErr = err.slice(0, 255); }
  a.lastSeenMs = Date.now();
}

async function flushTopics(): Promise<void> {
  if (topicAgg.size === 0) return;
  const entries = [...topicAgg.values()];
  topicAgg.clear();
  const rows = entries.map(() => "(?,?,?,?,?,?)").join(",");
  const params: (string | number | null)[] = [];
  for (const a of entries) params.push(a.topic, a.brokerId, a.valid, a.malformed, toMysqlUtc(new Date(a.lastSeenMs)), a.lastErr);
  try {
    await getPool().execute(
      `INSERT INTO packet_topics (topic_path, broker_id, valid_count, malformed_count, last_seen_at, last_error)
         VALUES ${rows}
       ON DUPLICATE KEY UPDATE
         valid_count = valid_count + VALUES(valid_count),
         malformed_count = malformed_count + VALUES(malformed_count),
         last_seen_at = VALUES(last_seen_at),
         last_error = IF(VALUES(malformed_count) > 0, VALUES(last_error), last_error)`,
      params,
    );
  } catch (e) {
    console.error(`[ingest] flushTopics failed, re-queuing counts: ${(e as Error).message}`);
    // Do not lose counts on a transient DB error: merge them back for the next flush.
    for (const a of entries) {
      const key = `${a.brokerId}\t${a.topic}`;
      const cur = topicAgg.get(key);
      if (cur) { cur.valid += a.valid; cur.malformed += a.malformed; cur.lastErr = cur.lastErr ?? a.lastErr; }
      else topicAgg.set(key, a);
    }
  }
}

async function logBridge(direction: "out" | "in", fromBroker: string, toBroker: string, fromNode: number, packetId: number, channel: string, topic: string, destTopic: string): Promise<void> {
  await getPool()
    .execute(
      `INSERT INTO bridge_log (bridged_at, direction, from_broker, to_broker, from_node_id, mesh_packet_id, channel_id, topic, dest_topic)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      [toMysqlUtc(new Date()), direction, fromBroker, toBroker, fromNode, packetId, channel || null, topic.slice(0, 255), destTopic.slice(0, 255)],
    )
    .catch((e) => console.error(`[ingest] bridge_log failed: ${(e as Error).message}`));
}

async function flushHealth(connectors: BrokerConnector[]): Promise<void> {
  const pool = getPool();
  const now = toMysqlUtc(new Date());
  for (const c of connectors) {
    const s = c.state;
    await pool.execute(
      `INSERT INTO broker_health (broker_id, connected, last_message_at, messages, malformed, reconnects, updated_at)
         VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE connected=VALUES(connected), last_message_at=VALUES(last_message_at),
         messages=VALUES(messages), malformed=VALUES(malformed), reconnects=VALUES(reconnects), updated_at=VALUES(updated_at)`,
      [c.id, s.connected ? 1 : 0, s.lastMessageAt ? toMysqlUtc(new Date(s.lastMessageAt)) : null,
       s.messages, s.malformed, s.reconnects, now],
    );
  }
}

// Flush each broker's latest $SYS presence snapshot (client counts, uptime, version). Only writes a
// row once we have actually seen a $SYS reading (updatedAt set), so a broker that restricts $SYS
// leaves no stale/empty row rather than a misleading "0 clients".
async function flushBrokerSys(connectors: BrokerConnector[]): Promise<void> {
  const pool = getPool();
  for (const c of connectors) {
    const s = c.state.sys;
    if (s.updatedAt === null) continue;
    await pool.execute(
      `INSERT INTO broker_sys (broker_id, clients_connected, clients_active, clients_total,
         clients_disconnected, uptime_s, version, msgs_received, msgs_sent, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE clients_connected=VALUES(clients_connected), clients_active=VALUES(clients_active),
         clients_total=VALUES(clients_total), clients_disconnected=VALUES(clients_disconnected),
         uptime_s=VALUES(uptime_s), version=VALUES(version), msgs_received=VALUES(msgs_received),
         msgs_sent=VALUES(msgs_sent), updated_at=VALUES(updated_at)`,
      [c.id, s.clientsConnected, s.clientsActive, s.clientsTotal, s.clientsDisconnected,
       s.uptimeS, s.version, s.msgsReceived, s.msgsSent, toMysqlUtc(new Date(s.updatedAt))],
    ).catch((e) => console.error(`[ingest] broker_sys flush failed: ${(e as Error).message}`));
  }
}

// Report the RF station-node connection into broker_health under broker_id "node" so the web
// process (health page + navbar chip) can show its state. Removes the row when RX is disabled.
async function flushNodeHealth(nodeRx: NodeRxConnector | null): Promise<void> {
  const pool = getPool();
  if (!nodeRx) {
    await pool.execute(`DELETE FROM broker_health WHERE broker_id='node'`).catch(() => {});
    return;
  }
  const s = nodeRx.state;
  // `healthy`, not raw `connected`: a node that vanished without a FIN left the socket open and
  // reported connected forever while nothing was ingested. A deliberate yield (another process
  // holds the station-node lease for a TX publish or a config write) also reads as not connected,
  // which is honest: the stream really is down, and it comes back on its own within a second.
  await pool.execute(
    `INSERT INTO broker_health (broker_id, connected, last_message_at, messages, malformed, reconnects, updated_at)
       VALUES ('node',?,?,?,0,?,?)
     ON DUPLICATE KEY UPDATE connected=VALUES(connected), last_message_at=VALUES(last_message_at),
       messages=VALUES(messages), reconnects=VALUES(reconnects), updated_at=VALUES(updated_at)`,
    [nodeRx.healthy ? 1 : 0, s.lastPacketAt ? toMysqlUtc(new Date(s.lastPacketAt)) : null, s.packets, s.reconnects, toMysqlUtc(new Date())],
  ).catch((e) => console.error(`[ingest] node health flush failed: ${(e as Error).message}`));
}

main().catch((e) => {
  console.error(`[ingest] fatal: ${e.message}`);
  process.exit(1);
});
