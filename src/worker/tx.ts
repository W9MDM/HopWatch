import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import type { HopWatchConfig } from "../config/schema.ts";
import { getChannelKeys, getRuntimeBrokers } from "../db/settings.ts";
import { effectiveTopicRoot } from "../meshtastic/topic.ts";
import { encodeTx, encodeToRadio } from "../meshtastic/encode.ts";
import { readNodeConfig } from "../node/readconfig.ts";
import { rateAllowed, channelUtilOk, backoffMs, promote } from "../lib/txstate.ts";
import {
  listPendingTx, recentSentAtMs, watchable, heardBy, routingAnswer, recordConfirmation,
  updateOutbox, setState, emitTxState, enqueueTx, txLog, claimForSend, type OutboxRow,
} from "../db/tx.ts";
import { MqttTxTransport, type TxTransport } from "../tx/transport.ts";

// Per-broker MQTT transports for rows that target a specific broker (e.g. weather alerts). The
// default (null broker) uses the shared transport passed into runTxOutbox.
const brokerTransports = new Map<string, MqttTxTransport>();
/** A transport bound to a specific broker, cached per id. Exported so the RF->MQTT patcher can
 * publish to the broker whose topic root it built the topic from, instead of the TX broker. */
export function mqttFor(brokerId: string | null | undefined, fallback: TxTransport): TxTransport {
  if (!brokerId) return fallback;
  let t = brokerTransports.get(brokerId);
  if (!t) { t = new MqttTxTransport(brokerId); brokerTransports.set(brokerId, t); }
  return t;
}

/** Close every per-broker transport (called on worker shutdown so no MQTT connection leaks). */
export async function closeBrokerTransports(): Promise<void> {
  await Promise.all([...brokerTransports.values()].map((t) => t.close().catch(() => {})));
  brokerTransports.clear();
}

const MAX_ATTEMPTS = 5;
const NEEDS_TARGET = new Set(["dm", "traceroute", "position_req", "telemetry_req", "admin_probe"]);

function msOf(mysqlUtc: string): number {
  return new Date(mysqlUtc.replace(" ", "T") + "Z").getTime();
}

async function pendingCount(): Promise<number> {
  const rows = await query<{ c: number }>(`SELECT COUNT(*) c FROM tx_outbox WHERE state IN ('queued','held')`);
  return Number(rows[0]?.c ?? 0);
}

// Throttle gate-reason logging: log a given reason at most once per 60s so an idle install with
// queued rows does not fill the debug log every tick.
let lastGate = { msg: "", at: 0 };
async function logGateThrottled(msg: string): Promise<void> {
  const now = Date.now();
  if (msg === lastGate.msg && now - lastGate.at < 60_000) return;
  lastGate = { msg, at: now };
  await txLog(msg, { level: "warn" });
}

// Resolve a channel NAME to its index on the station node (needed only for the node transport,
// which sends decoded packets the node encrypts by channel index). Cached ~5 min so we do not
// re-dump the node config per message; unknown names fall back to 0 (primary).
let chanIdxCache: { at: number; map: Map<string, number> } | null = null;

/**
 * Resolve a channel NAME to its index on the station node, or null when the node demonstrably has
 * no such channel.
 *
 * A blanket fallback to 0 was wrong in one direction that matters: a message on a channel the
 * station node is not a member of was transmitted on its PRIMARY channel instead, i.e. onto a
 * different channel from the one it belongs to. That is most likely on the MQTT->RF bridge, where
 * the channel comes from whatever the peer broker carried. Null means "known to be absent" and the
 * caller fails the row; a MISSING channel table (the config read failed) still falls back to 0,
 * because that is ignorance rather than evidence and refusing every send would be worse.
 */
async function nodeChannelIndex(cfg: HopWatchConfig, name: string): Promise<number | null> {
  if (!name || !cfg.node.host) return 0;
  if (!chanIdxCache || Date.now() - chanIdxCache.at > 300_000) {
    try {
      const snap = await readNodeConfig(cfg.node.host, cfg.node.port);
      // Only cache a COMPLETE dump. A partial one (the node dropped the stream mid-dump) is missing
      // channels, and caching it pinned every message on those channels to index 0 for 5 minutes.
      if (snap.complete) chanIdxCache = { at: Date.now(), map: new Map(snap.channels.map((c) => [c.name, c.index])) };
    } catch { /* keep any prior cache; fall back below */ }
  }
  if (!chanIdxCache) return 0; // no table at all: no evidence either way
  return chanIdxCache.map.get(name) ?? null;
}

type BrokerRoot = { id: string; root_topic: string; topics: string[] };

/**
 * MQTT topic root for an outbound row: the broker's configured root (or one derived from its
 * subscribe topics), e.g. "msh" or "msh/US/IN/NWI". The firmware publishes/subscribes under
 * `<root>/2/e/<channel>/<node>` with a single-level "+" wildcard, so this must match the
 * gateway's root exactly. Returns "" when no broker resolves, and the caller fails the row
 * rather than publishing somewhere nothing is listening.
 *
 * Pure over a broker list read once per tick: resolving this per row would re-query the broker
 * table, and re-decrypt its secrets, for every queued message.
 */
function topicRootFor(brokers: BrokerRoot[], brokerId: string | null | undefined, txBrokerId: string): string {
  const want = brokerId || txBrokerId;
  const b = (want ? brokers.find((x) => x.id === want) : null) ?? brokers[0];
  return b ? effectiveTopicRoot(b.root_topic, b.topics).root : "";
}

async function isMuted(nodeId: number): Promise<boolean> {
  const rows = await query<{ m: number }>(`SELECT mute_hidden m FROM nodes WHERE node_id = ?`, [nodeId]);
  return Number(rows[0]?.m ?? 0) === 1;
}

/** Rough recent channel utilization (mesh-wide chan_util telemetry over 15 min). The guard
 * is a safety heuristic; util is not attributable to a single channel in the RX model. */
async function recentChannelUtil(): Promise<number | null> {
  const rows = await query<{ u: number | null }>(
    `SELECT AVG(value) u FROM node_telemetry WHERE metric = 'chan_util' AND observed_at >= (UTC_TIMESTAMP() - INTERVAL 15 MINUTE)`,
  );
  return rows[0]?.u == null ? null : Number(rows[0].u);
}

// Release a claimed (sending) row after a failed attempt: back to queued for retry (backoff via
// last_attempt_at), or terminal failed at the attempt cap. Must move it OUT of 'sending' or it
// would be stuck (sending rows are never re-selected).
async function fail(row: OutboxRow, err: string): Promise<void> {
  const attempts = row.attempts + 1;
  const now = toMysqlUtc(new Date());
  const state = attempts >= MAX_ATTEMPTS ? "failed" : "queued";
  await setState(row.id, state, { attempts, last_attempt_at: now, error: err.slice(0, 255) });
}

/**
 * Watch already-sent rows for delivery confirmation. Our own packet observed coming back via
 * N gateways is the implicit ACK (state -> heard); an explicit ROUTING ack upgrades to acked, and an
 * explicit NAK is recorded as a failure with its reason rather than being mistaken for an ack.
 * Runs even when disarmed, so acks of in-flight traffic still land.
 */
async function reconcileConfirmations(): Promise<void> {
  for (const row of await watchable()) {
    if (row.packet_id == null) continue;
    const heard = await heardBy(row.packet_id, row.from_node);
    for (const h of heard) await recordConfirmation(row.id, h.gatewayId, h.heardAt, false);
    // Correlated on OUR packet id via Data.request_id, so one node's ack can no longer promote every
    // other in-flight row (they all share our from_node, which is all the old query matched on).
    const answer = row.want_ack ? await routingAnswer(row.packet_id) : null;
    if (answer && !answer.acked) {
      // A NAK is proof of failed delivery. Record it as such, with the routing error the mesh gave.
      const why = `routing NAK: ${answer.errorName ?? "unknown"}`;
      if (row.state !== "failed") {
        await setState(row.id, "failed", { error: why });
        await txLog(why, { outboxId: row.id, level: "warn" });
      }
      continue;
    }
    const next = promote(row.state, { gatewayCount: heard.length, routingAck: !!answer?.acked });
    if (next !== row.state) await setState(row.id, next, {});
  }
}

/**
 * Optionally enqueue a NODEINFO announce so the mesh has a name for us. Off unless
 * tx.announce_interval_s > 0; rate-paced by the last announce's age.
 */
export async function maybeAnnounce(cfg: HopWatchConfig): Promise<void> {
  const tx = cfg.tx;
  if (!tx.enabled || !tx.armed || tx.from_node <= 0 || tx.announce_interval_s <= 0) return;
  const last = await query<{ c: string | null }>(`SELECT MAX(created_at) c FROM tx_outbox WHERE kind = 'announce'`);
  if (last[0]?.c && (Date.now() - msOf(last[0].c)) / 1000 < tx.announce_interval_s) return;
  const keys = await getChannelKeys();
  if (!keys[0]) return;
  await enqueueTx({
    createdBy: "announce", transport: tx.transport, kind: "announce", channelId: keys[0].name, toNode: null,
    fromNode: tx.from_node, payloadText: tx.node_long_name, hopLimit: tx.default_hop_limit, wantAck: false,
  });
}

/**
 * Drain the TX outbox. Enforces every safety rail in the worker (never the UI): TX must be
 * enabled AND armed with a from-node set; dry-run encodes but never publishes; per-minute/hour
 * rate caps; channel-util hold; mute refusal; hop-limit cap. Disarming halts the queue on the
 * next tick (rows stay queued).
 */
export async function runTxOutbox(cfg: HopWatchConfig, transports: { mqtt: TxTransport; node: TxTransport }): Promise<number> {
  const tx = cfg.tx;

  if (tx.enabled) await reconcileConfirmations();

  // Explain, in the UI-visible log, why queued rows are not moving: gate reasons are throttled so
  // an idle disabled/disarmed install does not spam the log, but the operator can see the cause.
  const gate = !tx.enabled ? "TX is disabled (Enabled off)"
    : tx.from_node <= 0 ? "no From node set (tx.from_node)"
    : !tx.armed ? "not armed"
    : null;
  if (gate) {
    const waiting = await pendingCount();
    if (waiting > 0) await logGateThrottled(`${waiting} message(s) queued but not sending: ${gate}`);
    return 0;
  }

  const pending = await listPendingTx(50);
  if (pending.length === 0) return 0;

  const keys = new Map((await getChannelKeys()).map((k) => [k.name, k.key]));
  const recent = await recentSentAtMs();
  // Channel utilization cannot change within a tick: read it once, not once per pending row
  // (audit P6). Each held row still gets its own held-state write below.
  const util = await recentChannelUtil();
  // Broker roots feed the MQTT topic; read once per tick, never per row.
  const brokerRoots: BrokerRoot[] = await getRuntimeBrokers();
  let sent = 0;

  for (const row of pending) {
    // Respect per-row backoff after a failed attempt.
    if (row.last_attempt_at && Date.now() - msOf(row.last_attempt_at) < backoffMs(row.attempts)) continue;

    // Global rate limit: stop the tick once we are at the cap.
    if (!rateAllowed(recent, Date.now(), tx.rate_limit.per_minute, tx.rate_limit.per_hour)) break;

    // Never DM/traceroute/probe a muted node.
    if (NEEDS_TARGET.has(row.kind) && row.to_node != null && (await isMuted(row.to_node))) {
      await setState(row.id, "failed", { error: "target node is muted" });
      continue;
    }

    // Channel-util guard: hold (retry next tick) rather than transmit into a busy channel.
    if (!channelUtilOk(util, tx.max_channel_util)) {
      await setState(row.id, "held", { error: `channel util ${util?.toFixed(0)}% over ${tx.max_channel_util}%` });
      continue;
    }

    // Atomically claim the row (queued/held -> sending) before doing any transmit work. If the
    // claim loses (an overlapping tick / second worker already took it, or it was cancelled), skip.
    // This is what makes double-transmit and rate-limit-bypass under tick overlap impossible.
    if (!(await claimForSend(row.id))) continue;

    const channelName = row.channel_id ?? "";
    const key = keys.get(channelName) ?? "";
    const hopLimit = Math.min(row.hop_limit, tx.max_hop_limit);
    // Per-row transport wins (the RF patcher forces "node"); otherwise the global tx.transport.
    // admin_probe must use the station node -- only it can PKI-encrypt an admin request.
    const usingNode = row.kind === "admin_probe" ? true : (row.transport ?? tx.transport) === "node";
    // MQTT encodes the channel by name and encrypts here; a missing key would publish the
    // packet PLAINTEXT on a topic segment no gateway subscribes to (empty/unknown channel),
    // so fail the row loudly instead. An intentionally unencrypted channel is still possible
    // by storing an explicit 0x00 key. The node transport needs no key (the node encrypts).
    if (!usingNode && !key) {
      await fail(row, `no channel key for "${channelName || "(no channel)"}"; refusing unencrypted MQTT publish`);
      await txLog(`no channel key for "${channelName || "(no channel)"}"; refusing unencrypted MQTT publish`, { outboxId: row.id, level: "error" });
      continue;
    }
    // The node needs the channel index and encrypts on its side, so resolve the index from
    // the node's channel list.
    const channelIndex = usingNode ? await nodeChannelIndex(cfg, channelName) : 0;
    if (channelIndex === null) {
      const why = `the station node has no channel named "${channelName}"; refusing to transmit it on the node's primary channel instead`;
      await fail(row, why);
      await txLog(why, { outboxId: row.id, level: "error" });
      continue;
    }
    // The MQTT path needs the gateway's topic root; publishing under the wrong root is a silent
    // no-op (the broker matches it to no subscriber), so fail the row loudly instead.
    const topicRoot = usingNode ? "" : topicRootFor(brokerRoots, row.broker_id, tx.broker_id);
    if (!usingNode && !topicRoot) {
      await fail(row, "no MQTT topic root; set the broker's root topic in /admin/settings");
      await txLog("no MQTT topic root; set the broker's root topic in /admin/settings", { outboxId: row.id, level: "error" });
      continue;
    }
    const req = {
      kind: row.kind, fromNode: tx.from_node, toNode: row.to_node, channelIndex,
      channelName, channelKey: key, text: row.payload_text ?? undefined,
      longName: tx.node_long_name, shortName: tx.node_short_name,
      hopLimit, wantAck: !!row.want_ack, okToMqtt: tx.ok_to_mqtt, topicRoot,
      // REUSE the packet id from a previous attempt. A publish can fail after the packet actually
      // went out: the node transport writes the ToRadio frame, the node transmits it, and the socket
      // then errors inside the 1500 ms flush window (an ECONNRESET from an ESP32 juggling clients is
      // routine). The row returns to 'queued' and is retried, and minting a fresh random id made the
      // mesh treat the retry as a NEW message: dedup could not suppress it, so every receiver saw
      // the text twice, and the confirmations for the first id were orphaned. Keeping the id means a
      // retry of an already-aired packet is dropped by the mesh's own dedup, which is the behaviour
      // a resend is supposed to have.
      packetId: row.packet_id ?? undefined,
    };

    let packetId: number, payload: Uint8Array, topic = "";
    try {
      if (usingNode) { const r = await encodeToRadio(req); packetId = r.packetId; payload = r.frame; }
      else { const r = await encodeTx(req); packetId = r.packetId; payload = r.bytes; topic = r.topic; }
    } catch (e) {
      await fail(row, `encode failed: ${(e as Error).message}`);
      await txLog(`encode failed: ${(e as Error).message}`, { outboxId: row.id, level: "error" });
      continue;
    }

    await txLog(`${row.kind} via ${usingNode ? "node(RF)" : "mqtt"} ch="${channelName}" ci=${channelIndex}${topic ? ` topic="${topic}"` : ""} from=${tx.from_node >>> 0} packet=${packetId >>> 0}${tx.dry_run ? " [dry-run: not published]" : ""}`, { outboxId: row.id });

    // Persist the packet id BEFORE publishing, so a retry reuses it (see the packetId note above).
    // A publish that fails after the packet actually aired otherwise left packet_id NULL, and the
    // retry minted a new id that the mesh could not dedup against the copy already on the air.
    if (row.packet_id !== packetId) await updateOutbox(row.id, { packet_id: packetId });

    const now = toMysqlUtc(new Date());
    const common = { packet_id: packetId, encoded: Buffer.from(payload), sent_at: now, attempts: row.attempts + 1, last_attempt_at: now, error: null };

    // Dry-run: full pipeline (encode included) but nothing is published.
    if (tx.dry_run) {
      await updateOutbox(row.id, { state: "dry_run", ...common });
      await emitTxState(row.id, "dry_run", { packetId });
      recent.push(Date.now());
      sent++;
      continue;
    }

    // The transmit and the bookkeeping are deliberately in SEPARATE try blocks. Sharing one meant
    // a DB error after a successful publish (a blip, a deadlock, a dropped connection) landed in
    // the same catch as a transport failure and called fail(), returning the row to 'queued' so
    // the next tick transmitted a SECOND copy of a packet already on the air, while logging
    // "publish failed" about a publish that had actually succeeded.
    try {
      await (usingNode ? transports.node : mqttFor(row.broker_id, transports.mqtt)).publish(topic, payload);
    } catch (e) {
      await fail(row, `publish failed: ${(e as Error).message}`);
      await txLog(`publish failed: ${(e as Error).message}`, { outboxId: row.id, level: "error" });
      continue;
    }

    // Past this point the packet is on the air, so it counts against the rate limit whatever
    // happens next.
    recent.push(Date.now());
    sent++;

    try {
      await updateOutbox(row.id, { state: "sent", ...common });
      await emitTxState(row.id, "sent", { packetId });
      await txLog(`sent via ${usingNode ? "node(RF)" : "mqtt"}; awaiting heard-back/ack`, { outboxId: row.id });
    } catch (e) {
      // Recording failed but the transmission happened. Leave the row in 'sending': it is
      // invisible to listPendingTx so it can never be re-selected and re-transmitted, and
      // failInterruptedSends() reconciles stranded 'sending' rows on the next worker start with
      // the same conservative rule used for a crash mid-transmit (mark failed, never auto-resend,
      // because we cannot know whether the packet hit the air).
      await txLog(
        `PUBLISHED but could not record state: ${(e as Error).message}. Row left in 'sending' so it is never transmitted twice.`,
        { outboxId: row.id, level: "error" },
      ).catch(() => { /* logging is best effort; never mask the publish having succeeded */ });
    }
  }
  return sent;
}
