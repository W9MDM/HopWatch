import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getPool } from "../db/client.ts";
import { toMysqlUtc, dedupBucket, dedupLookupRange } from "../lib/time.ts";
import { classifyReception } from "../meshtastic/classify.ts";
import { recordTraceroute } from "../db/topology.ts";
import type { NormalizedEnvelope } from "../meshtastic/types.ts";

export interface IngestMeta {
  brokerId: string;
  rawTopic: string;
  /** The idempotency/dedup window in seconds (from config). */
  windowSeconds: number;
  /** How HopWatch heard this: an MQTT broker, or RF via the station node. Defaults to mqtt. */
  transport?: "mqtt" | "rf";
}

export interface IngestOutcome {
  newPacket: boolean;
  newReception: boolean;
  packetId: number;
  receptionClass: string;
}

/**
 * Persist one normalized envelope. Idempotent and restart-safe:
 *   - packets deduped on (from, mesh_packet_id, dedup_bucket) via first_seen_at
 *   - receptions deduped on (packet_id, gateway_id, rx_time) via INSERT IGNORE
 * All writes for a message happen in a single transaction.
 */
export interface LiveEvt { at: string; type: string; payload: string }

/** Multi-row append of collected SSE events (append-only, no upsert). */
export async function insertLiveEvents(conn: PoolConnection, evts: LiveEvt[]): Promise<void> {
  if (evts.length === 0) return;
  const rows = evts.map(() => "(?,?,?)").join(",");
  const params: string[] = [];
  for (const e of evts) params.push(e.at, e.type, e.payload);
  await conn.execute(`INSERT INTO live_events (created_at, event_type, payload) VALUES ${rows}`, params);
}

// liveSink lets the batch writer collect SSE events across many messages and flush them as one
// multi-row insert per transaction (P4). When omitted (single-message path), applyEnvelope flushes
// its own at the end.
export async function applyEnvelope(conn: PoolConnection, env: NormalizedEnvelope, meta: IngestMeta, liveSink?: LiveEvt[]): Promise<IngestOutcome> {
  const p = env.packet;
  const liveOut = liveSink ?? [];

  const receivedAt = new Date();
  // Trust the node-reported rx time only when it is plausible. A node with a bad RTC can
  // report a wildly future (or ancient) timestamp; because rx_time / first_seen_at are the
  // partition keys and every downstream observed_at derives from this, one bad clock would
  // poison partitions, rollups, and stretch every time-series chart out by years. When the
  // reported time is outside a sane window, fall back to the ingest wall clock.
  const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000; // tolerate up to 1h of clock skew ahead
  const MIN_PLAUSIBLE_MS = Date.UTC(2020, 0, 1); // anything older is a mis-set/mis-scaled clock
  const reportedMs = p.rxTimeMs || 0;
  const clockOk = reportedMs >= MIN_PLAUSIBLE_MS && reportedMs <= receivedAt.getTime() + MAX_FUTURE_SKEW_MS;
  const rxTime = clockOk ? new Date(reportedMs) : receivedAt;
  let bucket = dedupBucket(rxTime, meta.windowSeconds);
  // first_seen_at is the dedup-bucket start so re-broadcasts of the SAME packet id
  // collapse into one logical packet. With no id (0) we cannot dedup, so use the real
  // rx time to keep each one distinct instead of collapsing them all into one per bucket.
  const hasId = p.meshPacketId !== 0;
  let firstSeenAt = hasId ? new Date(bucket * meta.windowSeconds * 1000) : rxTime;

  // C8: a fixed wall-clock bucket splits two gateway copies whose rx times straddle a boundary
  // into two logical packets (double-counting the packet in every reception analytic). Roll the
  // dedup instead: if a packet row for this (from, mesh_packet_id) already exists within one
  // window of this rx time, reuse its bucket/first_seen_at so the copies map to one packet.
  if (hasId) {
    const range = dedupLookupRange(rxTime, meta.windowSeconds);
    const [ex] = await conn.execute<RowDataPacket[]>(
      `SELECT first_seen_at, dedup_bucket FROM packets
       WHERE from_node_id=? AND mesh_packet_id=? AND first_seen_at BETWEEN ? AND ?
       ORDER BY first_seen_at DESC LIMIT 1`,
      [p.from, p.meshPacketId, toMysqlUtc(range.from), toMysqlUtc(range.to)],
    );
    if (ex[0]) {
      firstSeenAt = new Date(String(ex[0].first_seen_at).replace(" ", "T") + "Z");
      bucket = Number(ex[0].dedup_bucket);
    }
  }
  // E3: the reception idempotency key (uq_rx) must include rx_time because receptions is
  // partitioned by it. When the node clock is untrusted we fall back to wall-clock, which differs
  // between two deliveries of the same packet+gateway and defeats the dedup on a cache miss. Use
  // the deterministic first_seen_at as the reception rx_time in that case so retries collapse.
  const rxRowTime = clockOk ? rxTime : firstSeenAt;

  const cls = classifyReception({
    gatewayId: env.gatewayId,
    fromNodeId: p.from,
    rxRssi: p.rxRssi,
    rxSnr: p.rxSnr,
    hopStart: p.hopStart,
    hopLimit: p.hopLimit,
    relayNode: p.relayNode,
  });

  const decodeStatus = p.decoded ? "decoded" : p.encrypted ? "encrypted" : "malformed";
  const portNum = p.decoded?.portnum ?? null;
  // channel_index means what its name says: a channel INDEX, or NULL when we do not have one.
  // MeshPacket.channel is a channel HASH on an encrypted-variant packet, so storing it here made
  // two receptions of one logical packet disagree (whichever wrote first won, and the column was
  // never COALESCEd) and made the packet page render a hash byte as "LongFast [37]". Nothing is
  // lost: the hash is a pure function of the channel name and its PSK, both of which we keep.
  const channelIndex = p.channelIsHash ? null : p.channel;
  // Only meaningful when the node clock was trusted; a bogus clock yields a nonsense lag.
  const ingestLagMs = clockOk ? receivedAt.getTime() - reportedMs : null;

  {
    // 1. Upsert the logical packet; recover its id whether inserted or matched.
    const [packetRes] = await conn.execute<ResultSetHeader>(
      `INSERT INTO packets
         (first_seen_at, first_reception_at, mesh_packet_id, from_node_id, to_node_id, dedup_bucket,
          channel_index, channel_id, port_num, decode_status, decode_error,
          want_ack, via_mqtt, ok_to_mqtt, payload_format, raw_json, reception_count, source_broker_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
       ON DUPLICATE KEY UPDATE
         id = LAST_INSERT_ID(id),
         first_reception_at = COALESCE(first_reception_at, VALUES(first_reception_at)),
         port_num = COALESCE(port_num, VALUES(port_num)),
         -- Backfill both channel columns from whichever copy actually knows them. One copy of a
         -- packet routinely knows what another does not: an encrypted MQTT copy we cannot decrypt
         -- has no channel name, and an RF copy the station node decrypted has an index but arrives
         -- after. Without this the first writer's NULL was permanent, which is what made the
         -- RF->MQTT patcher refuse every RF-only message (it looks the channel key up by name).
         channel_id = COALESCE(channel_id, VALUES(channel_id)),
         channel_index = COALESCE(channel_index, VALUES(channel_index)),
         decode_status = IF(decode_status='decoded','decoded',VALUES(decode_status))`,
      [
        toMysqlUtc(firstSeenAt), toMysqlUtc(receivedAt), p.meshPacketId, p.from, p.to, bucket,
        channelIndex, env.channelId || null, portNum, decodeStatus, null,
        p.wantAck ? 1 : 0, p.viaMqtt ? 1 : 0, p.okToMqtt ? 1 : 0, env.fromJson ? "json" : "protobuf",
        env.fromJson ? JSON.stringify(env) : null, meta.brokerId,
      ],
    );
    const packetId = packetRes.insertId;
    const newPacket = packetRes.affectedRows === 1; // 1=insert, 2=update

    // A later copy of a known packet can be the first to carry its channel name: an encrypted MQTT
    // copy we could not decrypt has none, while the station node's RF copy of the same packet does.
    // The upsert above COALESCEs the packets row, but the side tables are written once per logical
    // packet, so the text row keeps whatever the first decoding copy knew. Backfill it: the
    // RF->MQTT patcher looks its channel key up by this name, and the forwarding channel allowlist
    // filters on it. uq_source_packet makes this a single-row lookup.
    if (!newPacket && env.channelId) {
      await conn.execute(
        `UPDATE text_message SET channel_id=? WHERE source_packet_id=? AND channel_id IS NULL`,
        [env.channelId, packetId],
      );
    }

    // 2. Idempotent reception insert. RF is authoritative: when the same packet+gateway was
    //    already recorded via the node's MQTT uplink, upgrade that reception to transport=rf
    //    (with the RF radio's own metrics) instead of adding a duplicate row. The reception was
    //    already counted, so this is not a new reception.
    if (meta.transport === "rf") {
      const [upg] = await conn.execute<ResultSetHeader>(
        `UPDATE receptions SET transport='rf', rx_rssi=?, rx_snr=?, hop_start=?, hop_limit=?, relay_node=?, reception_class=?
         WHERE packet_id=? AND packet_first_seen_at=? AND gateway_id=? AND transport<>'rf'`,
        [p.rxRssi, p.rxSnr, p.hopStart, p.hopLimit, p.relayNode, cls.class, packetId, toMysqlUtc(firstSeenAt), env.gatewayId],
      );
      if (upg.affectedRows > 0) {
        // Same trap as the duplicate-reception path below: this RF copy may decode a packet whose
        // MQTT copy could not (no channel key, or the node had already decrypted it), and returning
        // here skipped writeDecoded entirely. The packet then showed decode_status='decoded' with
        // port_num set while text_message / node_position_events / node_telemetry / link_events had
        // nothing, and nothing retries: decoded_side_written has no other reader and there is no
        // backfill job. Systematic whenever a NodeRxConnector reconnect replays the node's buffered
        // backlog behind already-landed MQTT copies. The claim is atomic, so this cannot double-write.
        if (p.decoded?.parsed) {
          const [claim] = await conn.execute<ResultSetHeader>(
            `UPDATE packets SET decoded_side_written=1 WHERE id=? AND first_seen_at=? AND decoded_side_written=0`,
            [packetId, toMysqlUtc(firstSeenAt)],
          );
          if (claim.affectedRows === 1) {
            await writeDecoded(conn, p.from, p.to, packetId, rxTime, p.decoded.parsed, env.channelId || null, channelIndex, meta.brokerId, meta.rawTopic);
          }
        }
        return { newPacket: false, newReception: false, packetId, receptionClass: cls.class };
      }
    }
    const [rxRes] = await conn.execute<ResultSetHeader>(
      `INSERT IGNORE INTO receptions
         (rx_time, received_at, packet_id, packet_first_seen_at, gateway_id, from_node_id,
          rx_rssi, rx_snr, hop_start, hop_limit, relay_node, reception_class,
          raw_topic, source_broker_id, is_json, ingest_lag_ms, transport)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        toMysqlUtc(rxRowTime), toMysqlUtc(receivedAt), packetId, toMysqlUtc(firstSeenAt),
        env.gatewayId, p.from, p.rxRssi, p.rxSnr, p.hopStart, p.hopLimit, p.relayNode,
        cls.class, meta.rawTopic, meta.brokerId, env.fromJson ? 1 : 0, ingestLagMs,
        meta.transport === "rf" ? "rf" : "mqtt",
      ],
    );
    const newReception = rxRes.affectedRows === 1;

    if (!newReception) {
      // The reception row already exists (uq_rx is packet_id+gateway_id+rx_time), but this copy may
      // still carry a decoded payload the winning copy did not have: the JSON and protobuf
      // publications of one packet share all three key columns, and an in-process dedup miss
      // (restart, cache eviction) lets the second copy reach here. Returning immediately dropped
      // its payload even though the packets upsert above had already promoted decode_status to
      // 'decoded' and set port_num, leaving a packet marked decoded with no text_message or
      // position row behind it. The claim is atomic, so attempting it here can never double-write.
      if (p.decoded?.parsed) {
        const [claim] = await conn.execute<ResultSetHeader>(
          `UPDATE packets SET decoded_side_written=1 WHERE id=? AND first_seen_at=? AND decoded_side_written=0`,
          [packetId, toMysqlUtc(firstSeenAt)],
        );
        if (claim.affectedRows === 1) {
          await writeDecoded(conn, p.from, p.to, packetId, rxTime, p.decoded.parsed, env.channelId || null, channelIndex, meta.brokerId, meta.rawTopic);
        }
      }
      return { newPacket: false, newReception: false, packetId, receptionClass: cls.class };
    }

    // 3. Bump packet reception count.
    await conn.execute(
      `UPDATE packets SET reception_count = reception_count + 1 WHERE id=? AND first_seen_at=?`,
      [packetId, toMysqlUtc(firstSeenAt)],
    );

    // 4. Nodes + gateway identity/last-seen.
    await upsertNode(conn, p.from, rxTime, newPacket);
    if (env.gatewayId && env.gatewayId !== p.from) {
      // Track the gateway node's identity/last-seen, but do not count this as a reception of it.
      await upsertNode(conn, env.gatewayId, rxTime, false, false);
    }
    await markGateway(conn, env.gatewayId, meta.brokerId, rxTime);
    if (env.gatewayId === p.from) {
      await conn.execute(`UPDATE nodes SET is_gateway=1 WHERE node_id=?`, [p.from]);
    }

    // 5. Gateway<->node link aggregate (skip self-gated / mqtt-injected: no RF observation).
    if (cls.class === "rf_direct" || cls.class === "rf_direct_low_conf" || cls.class === "rf_relayed" || cls.class === "unknown") {
      await upsertLink(conn, env.gatewayId, p.from, cls.class, p.rxRssi, p.rxSnr, p.relayNode, rxTime);
    }

    // 6. Side tables from decoded payload. These are packet-level facts (a text message, a
    //    position, a traceroute), so write them once per logical packet, NOT once per gateway
    //    reception. We gate on the first reception that actually DECODES, not merely the first
    //    reception of the packet: an earlier copy may have been undecodable (encrypted, key
    //    missing) while a later gateway's copy decodes. The atomic claim below flips
    //    decoded_side_written 0->1 exactly once, so we write the side-data on that first
    //    successful decode and never double-write when several gateways decode the same packet.
    if (p.decoded?.parsed) {
      const [claim] = await conn.execute<ResultSetHeader>(
        `UPDATE packets SET decoded_side_written=1 WHERE id=? AND first_seen_at=? AND decoded_side_written=0`,
        [packetId, toMysqlUtc(firstSeenAt)],
      );
      if (claim.affectedRows === 1) {
        await writeDecoded(conn, p.from, p.to, packetId, rxTime, p.decoded.parsed, env.channelId || null, channelIndex, meta.brokerId, meta.rawTopic);
      }
    }

    // 7. Raw ciphertext retention for later re-decode. Kept even when a channel key APPEARED to
    //    decode the packet: key selection is a guess whenever no configured key's hash matches
    //    MeshPacket.channel, the upsert above pins decode_status='decoded' and port_num forever,
    //    and no job anywhere re-decodes, so discarding the bytes made a wrong key permanent. One
    //    row per logical packet is enough for a decoded packet (every gateway copy carries the same
    //    ciphertext, and the PK is (packet_id, stored_at) so a per-reception insert would not
    //    collapse); an undecodable packet keeps storing per reception, as before, because a later
    //    copy may be the first one that arrives with a payload at all.
    if (p.cipherText && (newPacket || !p.decoded)) {
      await conn.execute(
        `INSERT IGNORE INTO packet_payloads (packet_id, packet_first_seen_at, stored_at, channel_id, encrypted_payload)
         VALUES (?,?,?,?,?)`,
        [packetId, toMysqlUtc(firstSeenAt), toMysqlUtc(receivedAt), env.channelId || null, Buffer.from(p.cipherText)],
      );
    }

    // 8. Live event for SSE (enriched for the live map: hop metadata, relay byte, channel). Only
    //    RF classes are emitted: the live map animates receptions as over-the-air pulses/rings, so
    //    a node's own MQTT self-uplink (mqtt_self) or an injected copy must NOT pulse as if a
    //    gateway heard it on RF (path honesty; matches the link-aggregate exclusion above).
    if (cls.class === "rf_direct" || cls.class === "rf_direct_low_conf" || cls.class === "rf_relayed") {
      liveOut.push({
        at: toMysqlUtc(receivedAt), type: "reception",
        payload: JSON.stringify({
          packetId, from: p.from, gateway: env.gatewayId, port: portNum, broker: meta.brokerId,
          class: cls.class, rssi: p.rxRssi, snr: p.rxSnr, rxTime: rxTime.toISOString(),
          hopStart: p.hopStart, hopLimit: p.hopLimit, relayNode: p.relayNode, channel: p.channel,
        }),
      });
    }

    // 8b. Traceroute events carry the decoded hop path so the map can replay it. Once per
    //     logical packet (not per gateway) so the animation isn't replayed N times.
    if (newPacket && p.decoded?.parsed?.kind === "traceroute") {
      const tr = p.decoded.parsed;
      liveOut.push({
        at: toMysqlUtc(receivedAt), type: "traceroute",
        payload: JSON.stringify({ packetId, from: p.from, to: p.to, route: tr.route, snrTowards: tr.snrTowards, snrBack: tr.snrBack }),
      });
      // Fold the hop path into the persistent topology + traceroute freshness, ON THIS
      // TRANSACTION. It used to run on a separate pooled connection in autocommit "so it never
      // blocks ingest", but its times_seen increment is not idempotent, so it survived a batch
      // rollback and was then applied a second time by the individual retry: every edge on that
      // route gained a permanent extra count, once per batch failure.
      await recordTraceroute(conn, [p.from, ...tr.route], tr.snrTowards);
      // Register every node the traceroute names -- origin, destination and each hop (forward and
      // back) -- so nodes we have not otherwise heard still appear in the node list and get named
      // once their NodeInfo arrives, instead of showing as unknown !ids. Stub-only (INSERT IGNORE):
      // it never fabricates activity counters or overwrites a known node's identity.
      const seenTs = toMysqlUtc(receivedAt);
      const tracedNodes = new Set<number>(
        [p.from, ...(p.to && p.to !== 0xffffffff ? [p.to] : []), ...tr.route, ...(tr.routeBack ?? [])].filter((n) => n > 0),
      );
      for (const n of tracedNodes) {
        await conn.execute(`INSERT IGNORE INTO nodes (node_id, first_seen_at, last_seen_at) VALUES (?,?,?)`, [n, seenTs, seenTs]);
      }
    }

    // No external sink: flush this message's events now (single-message path). With a sink, the
    // batch writer flushes all collected events as one insert per transaction.
    if (!liveSink) await insertLiveEvents(conn, liveOut);
    return { newPacket, newReception: true, packetId, receptionClass: cls.class };
  }
}

// Single-message convenience wrapper: one transaction per message. Used by tests and
// as a fallback; the daemon uses BatchIngestor (many messages per transaction).
export async function processEnvelope(env: NormalizedEnvelope, meta: IngestMeta): Promise<IngestOutcome> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const r = await applyEnvelope(conn, env, meta);
    await conn.commit();
    return r;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// incrReception must be false when upserting the GATEWAY node for a reception it forwarded: the
// gateway did the hearing, it was not itself "received", so counting it would double-attribute
// one reception to two nodes and inflate busy gateways' total_reception_count.
async function upsertNode(conn: PoolConnection, nodeId: number, seenAt: Date, incrPacket: boolean, incrReception = true): Promise<void> {
  await conn.execute(
    `INSERT INTO nodes (node_id, first_seen_at, last_seen_at, total_packet_count, total_reception_count)
       VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       last_seen_at = GREATEST(COALESCE(last_seen_at, VALUES(last_seen_at)), VALUES(last_seen_at)),
       total_packet_count = total_packet_count + VALUES(total_packet_count),
       total_reception_count = total_reception_count + VALUES(total_reception_count)`,
    [nodeId, toMysqlUtc(seenAt), toMysqlUtc(seenAt), incrPacket ? 1 : 0, incrReception ? 1 : 0],
  );
}

async function markGateway(conn: PoolConnection, gatewayId: number, brokerId: string, seenAt: Date): Promise<void> {
  if (!gatewayId) return;
  await conn.execute(
    `INSERT INTO gateways (gateway_id, is_our_gateway, first_seen_at, last_seen_at, active, broker_id)
       VALUES (?,1,?,?,1,?)
     ON DUPLICATE KEY UPDATE last_seen_at=VALUES(last_seen_at), active=1, broker_id=VALUES(broker_id)`,
    [gatewayId, toMysqlUtc(seenAt), toMysqlUtc(seenAt), brokerId],
  );
  await conn.execute(`UPDATE nodes SET is_gateway=1 WHERE node_id=?`, [gatewayId]);
}

async function upsertLink(
  conn: PoolConnection, gatewayId: number, nodeId: number, cls: string,
  rssi: number | null, snr: number | null, relay: number | null, at: Date,
): Promise<void> {
  const isDirect = cls === "rf_direct";
  const isRelayed = cls === "rf_relayed";
  const isUnknown = cls === "rf_direct_low_conf" || cls === "unknown";
  const ts = toMysqlUtc(at);
  await conn.execute(
    `INSERT INTO gateway_node_link
       (gateway_id, node_id, direct_count, relayed_count, unknown_count,
        first_direct_at, last_direct_at, first_relayed_at, last_relayed_at,
        rssi_min, rssi_max, rssi_sum, rssi_sumsq, snr_min, snr_max, snr_sum, snr_sumsq,
        rssi_direct_sum, rssi_direct_count, rssi_direct_min, rssi_direct_max,
        snr_direct_sum, snr_direct_count,
        last_rssi, last_snr, last_direct_rssi, last_direct_snr, last_direct_rf_at, snr_direct_min, snr_direct_max, last_relay_node, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       direct_count = direct_count + VALUES(direct_count),
       relayed_count = relayed_count + VALUES(relayed_count),
       unknown_count = unknown_count + VALUES(unknown_count),
       first_direct_at = LEAST(COALESCE(first_direct_at, VALUES(first_direct_at)), COALESCE(VALUES(first_direct_at), first_direct_at)),
       last_direct_at  = GREATEST(COALESCE(last_direct_at, VALUES(last_direct_at)),  COALESCE(VALUES(last_direct_at),  last_direct_at)),
       first_relayed_at = LEAST(COALESCE(first_relayed_at, VALUES(first_relayed_at)), COALESCE(VALUES(first_relayed_at), first_relayed_at)),
       last_relayed_at  = GREATEST(COALESCE(last_relayed_at, VALUES(last_relayed_at)),  COALESCE(VALUES(last_relayed_at),  last_relayed_at)),
       rssi_min = LEAST(COALESCE(rssi_min, VALUES(rssi_min)), COALESCE(VALUES(rssi_min), rssi_min)),
       rssi_max = GREATEST(COALESCE(rssi_max, VALUES(rssi_max)), COALESCE(VALUES(rssi_max), rssi_max)),
       rssi_sum = rssi_sum + VALUES(rssi_sum),
       rssi_sumsq = rssi_sumsq + VALUES(rssi_sumsq),
       snr_min = LEAST(COALESCE(snr_min, VALUES(snr_min)), COALESCE(VALUES(snr_min), snr_min)),
       snr_max = GREATEST(COALESCE(snr_max, VALUES(snr_max)), COALESCE(VALUES(snr_max), snr_max)),
       snr_sum = snr_sum + VALUES(snr_sum),
       snr_sumsq = snr_sumsq + VALUES(snr_sumsq),
       rssi_direct_sum = rssi_direct_sum + VALUES(rssi_direct_sum),
       rssi_direct_count = rssi_direct_count + VALUES(rssi_direct_count),
       rssi_direct_min = LEAST(COALESCE(rssi_direct_min, VALUES(rssi_direct_min)), COALESCE(VALUES(rssi_direct_min), rssi_direct_min)),
       rssi_direct_max = GREATEST(COALESCE(rssi_direct_max, VALUES(rssi_direct_max)), COALESCE(VALUES(rssi_direct_max), rssi_direct_max)),
       snr_direct_sum = snr_direct_sum + VALUES(snr_direct_sum),
       snr_direct_count = snr_direct_count + VALUES(snr_direct_count),
       last_rssi = COALESCE(VALUES(last_rssi), last_rssi),
       last_snr = COALESCE(VALUES(last_snr), last_snr),
       last_direct_rssi = COALESCE(VALUES(last_direct_rssi), last_direct_rssi),
       last_direct_snr = COALESCE(VALUES(last_direct_snr), last_direct_snr),
       last_direct_rf_at = COALESCE(VALUES(last_direct_rf_at), last_direct_rf_at),
       snr_direct_min = LEAST(COALESCE(snr_direct_min, VALUES(snr_direct_min)), COALESCE(VALUES(snr_direct_min), snr_direct_min)),
       snr_direct_max = GREATEST(COALESCE(snr_direct_max, VALUES(snr_direct_max)), COALESCE(VALUES(snr_direct_max), snr_direct_max)),
       last_relay_node = COALESCE(VALUES(last_relay_node), last_relay_node),
       status = IF(direct_count > 0, 'direct', IF(relayed_count > 0, 'relayed', 'never'))`,
    [
      gatewayId, nodeId, isDirect ? 1 : 0, isRelayed ? 1 : 0, isUnknown ? 1 : 0,
      isDirect ? ts : null, isDirect ? ts : null, isRelayed ? ts : null, isRelayed ? ts : null,
      rssi, rssi, rssi ?? 0, rssi != null ? rssi * rssi : 0,
      snr, snr, snr ?? 0, snr != null ? snr * snr : 0,
      // Direct-only accumulators (Rule 4): only a zero-hop reception characterizes the source
      // node's own link, so relayed/low-confidence signal must not land here.
      isDirect && rssi != null ? rssi : 0, isDirect && rssi != null ? 1 : 0,
      isDirect ? rssi : null, isDirect ? rssi : null,
      isDirect && snr != null ? snr : 0, isDirect && snr != null ? 1 : 0,
      rssi, snr,
      // Last DIRECT metrics: only a zero-hop reception describes the source node's own link, so
      // relayed/low-confidence RF must never land here (Rule 4).
      isDirect ? rssi : null, isDirect ? snr : null, isDirect ? ts : null,
      isDirect ? snr : null, isDirect ? snr : null,
      relay,
      isDirect ? "direct" : isRelayed ? "relayed" : "never",
    ],
  );
}

async function writeDecoded(
  conn: PoolConnection, nodeId: number, toNode: number | null, packetId: number, at: Date, parsed: NonNullable<NormalizedEnvelope["packet"]["decoded"]>["parsed"],
  channelId: string | null, channelIndex: number | null, sourceBroker: string, sourceTopic: string,
): Promise<void> {
  if (!parsed) return;
  const ts = toMysqlUtc(at);
  switch (parsed.kind) {
    case "position": {
      await conn.execute(
        `INSERT INTO node_position_events (node_id, latitude, longitude, altitude_m, observed_at, source_packet_id)
         VALUES (?,?,?,?,?,?)`,
        [nodeId, parsed.latitude, parsed.longitude, parsed.altitudeM, ts, packetId],
      );
      await conn.execute(
        `INSERT INTO node_positions (node_id, latitude, longitude, altitude_m, precision_bits, source, last_updated_at)
           VALUES (?,?,?,?,?,'position',?)
         ON DUPLICATE KEY UPDATE latitude=VALUES(latitude), longitude=VALUES(longitude),
           altitude_m=VALUES(altitude_m), precision_bits=VALUES(precision_bits), last_updated_at=VALUES(last_updated_at)`,
        [nodeId, parsed.latitude, parsed.longitude, parsed.altitudeM, parsed.precisionBits, ts],
      );
      await conn.execute(`UPDATE nodes SET last_position_at=? WHERE node_id=?`, [ts, nodeId]);
      break;
    }
    case "telemetry": {
      for (const [metric, value] of Object.entries(parsed.metrics)) {
        await conn.execute(
          `INSERT INTO node_telemetry (observed_at, node_id, metric, value, source_packet_id) VALUES (?,?,?,?,?)`,
          [ts, nodeId, metric, value, packetId],
        );
      }
      break;
    }
    case "nodeinfo": {
      await applyIdentity(conn, nodeId, at, parsed);
      break;
    }
    case "mapreport": {
      // A node's opt-in self-report on the `/2/map/` topic. Identity flows through the same path
      // as NODEINFO so change events stay consistent, and this is the only passive source of
      // firmware_version (otherwise it is populated only by the opt-in remote-admin scanner).
      await applyIdentity(conn, nodeId, at, parsed);
      if (parsed.firmwareVersion) {
        await conn.execute(
          `UPDATE nodes SET firmware_version=? WHERE node_id=?`,
          [parsed.firmwareVersion.slice(0, 64), nodeId],
        );
      }
      // The radio profile: region, modem preset, whether the node is still on the public default
      // channel, and its own count of the local mesh. All four were decoded and then dropped. A node
      // whose region or preset differs from the rest of the mesh is visible over MQTT but cannot be
      // heard on RF, which is indistinguishable from a bad antenna without this.
      if (parsed.region || parsed.modemPreset || parsed.hasDefaultChannel !== undefined || parsed.numOnlineLocalNodes !== null) {
        await conn.execute(
          `UPDATE nodes SET region=COALESCE(?, region), modem_preset=COALESCE(?, modem_preset),
                            has_default_channel=COALESCE(?, has_default_channel),
                            reported_local_nodes=COALESCE(?, reported_local_nodes),
                            radio_profile_at=?
           WHERE node_id=?`,
          [
            parsed.region ?? null, parsed.modemPreset ?? null,
            parsed.hasDefaultChannel === undefined ? null : (parsed.hasDefaultChannel ? 1 : 0),
            parsed.numOnlineLocalNodes, ts, nodeId,
          ],
        );
      }
      // The position in a map report is deliberately coarsened by the sender (position_precision
      // bits), so it is recorded with its own provenance and must never masquerade as a GPS fix.
      // COALESCE on precision_bits/altitude means a coarse map report cannot erase a finer value
      // already learned from a real POSITION_APP packet.
      if (parsed.latitude !== null && parsed.longitude !== null) {
        await conn.execute(
          `INSERT INTO node_positions (node_id, latitude, longitude, altitude_m, precision_bits, source, last_updated_at)
             VALUES (?,?,?,?,?,'map_report',?)
           ON DUPLICATE KEY UPDATE
             latitude=VALUES(latitude), longitude=VALUES(longitude),
             altitude_m=COALESCE(VALUES(altitude_m), altitude_m),
             precision_bits=COALESCE(VALUES(precision_bits), precision_bits),
             source=VALUES(source), last_updated_at=VALUES(last_updated_at)`,
          [nodeId, parsed.latitude, parsed.longitude, parsed.altitudeM, parsed.precisionBits, ts],
        );
      }
      break;
    }
    case "keyverification": {
      if (parsed.nonce === 0) return; // no correlator, nothing to record
      await conn.execute(
        `INSERT IGNORE INTO key_verification (nonce, from_node_id, to_node_id, stage, observed_at, source_packet_id)
         VALUES (?,?,?,?,?,?)`,
        [parsed.nonce, nodeId, toNode, parsed.stage, ts, packetId],
      );
      return;
    }
    case "sensor": {
      // Its own table, not text_message: a door sensor or a mesh alert is not chat, so it must not
      // show up in /messages nor be eligible for the RF<->MQTT text patcher.
      await conn.execute(
        `INSERT IGNORE INTO sensor_event (node_id, kind, body, channel_id, observed_at, source_packet_id)
         VALUES (?,?,?,?,?,?)`,
        [nodeId, parsed.sensorKind, parsed.text.slice(0, 512), channelId, ts, packetId],
      );
      return;
    }
    case "routing": {
      // Only ack/NAK answers are worth recording; a route request/reply carries no request_id.
      if (parsed.requestId === 0 || parsed.errorCode < 0) return;
      await conn.execute(
        `INSERT IGNORE INTO routing_ack (request_id, from_node_id, to_node_id, error_code, error_name, observed_at, source_packet_id)
         VALUES (?,?,?,?,?,?,?)`,
        [parsed.requestId, nodeId, toNode, parsed.errorCode, parsed.errorName, ts, packetId],
      );
      return;
    }
    case "traceroute": {
      // The traceroute's target is the packet DESTINATION (toNode), not the last hop in `route`.
      // The old `route[last] ?? nodeId` collapsed a bare request (empty route) to the sender
      // itself, producing bogus "X -> X" self-loops on the results page. Fall back to the old
      // derivation only if the destination is missing/broadcast.
      const BROADCAST = 0xffffffff;
      const target = toNode && toNode !== BROADCAST ? toNode : (parsed.route[parsed.route.length - 1] ?? nodeId);
      await conn.execute(
        `INSERT INTO link_events (from_node_id, to_node_id, observed_at, direction, hop_count, route, snr_towards, snr_back, source_packet_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          nodeId, target, ts, "forward",
          parsed.route.length, JSON.stringify(parsed.route),
          JSON.stringify(parsed.snrTowards), JSON.stringify(parsed.snrBack), packetId,
        ],
      );
      break;
    }
    case "neighborinfo": {
      const reporter = parsed.node || nodeId;
      for (const nb of parsed.neighbors) {
        if (!nb.node || nb.node === reporter) continue;
        await conn.execute(
          `INSERT INTO node_neighbor (node_id, neighbor_id, snr, updated_at) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE snr=VALUES(snr), updated_at=VALUES(updated_at)`,
          [reporter, nb.node, Number.isFinite(nb.snr) ? nb.snr : null, ts],
        );
      }
      break;
    }
    case "text": {
      // INSERT IGNORE + the unique key on source_packet_id is the RX watchdog: even if this
      // ran per reception, only one message row per logical packet survives.
      // to_node_id is NULL for channel broadcasts and the target for directed messages (DMs),
      // so the log, chat, and forwarding can tell the two apart.
      const dmTo = toNode != null && toNode !== 0 && toNode !== 0xffffffff ? toNode : null;
      await conn.execute(
        `INSERT IGNORE INTO text_message (observed_at, from_node_id, to_node_id, channel_id, channel_index, body, source_packet_id, source_broker_id, source_topic, reply_to_packet_id, is_reaction)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [ts, nodeId, dmTo, channelId, channelIndex, parsed.text.slice(0, 512), packetId, sourceBroker || null, sourceTopic || null,
         parsed.replyToPacketId ?? null, parsed.isReaction ? 1 : 0],
      );
      break;
    }
    default:
      break; // raw / unknown: retained on the packet, no side table
  }
}

/** Diff nodeinfo against the current node row; write identity events + spoof flags. */
async function applyIdentity(
  conn: PoolConnection, nodeId: number, at: Date,
  info: { longName?: string; shortName?: string; hwModel?: string; role?: string; publicKey?: Uint8Array; isLicensed?: boolean; firmwareVersion?: string },
): Promise<void> {
  const ts = toMysqlUtc(at);
  const [rows] = await conn.execute(
    `SELECT long_name, short_name, hw_model, role, public_key_hex, firmware_version FROM nodes WHERE node_id=? FOR UPDATE`,
    [nodeId],
  );
  const cur = (rows as any[])[0] ?? {};
  const pkHex = info.publicKey ? Buffer.from(info.publicKey).toString("hex") : undefined;

  const changes: [string, string | undefined, string | undefined][] = [];
  const check = (type: string, oldV: string | null | undefined, newV: string | undefined) => {
    if (newV !== undefined && newV !== "" && newV !== (oldV ?? undefined)) changes.push([type, oldV ?? undefined, newV]);
  };
  check("long_name", cur.long_name, info.longName);
  check("short_name", cur.short_name, info.shortName);
  check("hw_model", cur.hw_model, info.hwModel);
  check("role", cur.role, info.role);
  check("public_key", cur.public_key_hex, pkHex);
  // node_identity_events has always had a 'firmware' event type; nothing ever emitted one, so the
  // fleet's firmware picture had no time dimension at all: only a current-value column, with no way
  // to see an upgrade wave roll through or to correlate a node's misbehaviour with when it changed
  // build. Map reports are the passive source of this (the only one, absent the opt-in admin
  // scanner), so the diff belongs here alongside the others.
  check("firmware", cur.firmware_version, info.firmwareVersion);

  for (const [type, oldV, newV] of changes) {
    await conn.execute(
      `INSERT INTO node_identity_events (node_id, event_type, old_value, new_value, observed_at)
       VALUES (?,?,?,?,?)`,
      [nodeId, type, oldV ?? null, newV ?? null, ts],
    );
    // Spoof signal: public key changed for a node we already knew a key for.
    if (type === "public_key" && oldV) {
      await conn.execute(
        `INSERT INTO node_flags (node_id, flag_type, severity, message, created_at, evidence)
         VALUES (?,?,?,?,?,?)`,
        [nodeId, "spoof_pubkey", "critical", `public key changed from ${oldV} to ${newV}`, ts,
         JSON.stringify({ old: oldV, new: newV })],
      );
      await conn.execute(`UPDATE nodes SET spoof_flag_count = spoof_flag_count + 1 WHERE node_id=?`, [nodeId]);
    }
  }

  // NULLIF(?, '') so a blank incoming value never overwrites a stored one. A NodeInfo/user with an
  // empty longName/shortName (a just-reset node, a partial decode, a proxy that lost the fields)
  // would otherwise clobber a good name to "", which then renders as the bare "!<id>". Meshtastic
  // names are never legitimately empty (the firmware defaults them), so empty always means "unknown".
  await conn.execute(
    `UPDATE nodes SET
       long_name = COALESCE(NULLIF(?, ''), long_name),
       short_name = COALESCE(NULLIF(?, ''), short_name),
       hw_model = COALESCE(NULLIF(?, ''), hw_model),
       role = COALESCE(NULLIF(?, ''), role),
       public_key = COALESCE(?, public_key),
       public_key_hex = COALESCE(?, public_key_hex),
       is_licensed = COALESCE(?, is_licensed)
     WHERE node_id=?`,
    [
      info.longName ?? null, info.shortName ?? null, info.hwModel ?? null, info.role ?? null,
      info.publicKey ? Buffer.from(info.publicKey) : null, pkHex ?? null,
      info.isLicensed === undefined ? null : info.isLicensed ? 1 : 0, nodeId,
    ],
  );

  // Role-claim validation: CLIENT_MUTE must not relay (checked elsewhere against relay_nodes).
  if (info.role && info.role.toUpperCase().includes("CLIENT_MUTE")) {
    await conn.execute(`UPDATE nodes SET role=? WHERE node_id=?`, [info.role, nodeId]);
  }
}
