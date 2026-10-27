import { query, getPool } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { getChannelKeys, getRuntimeBrokers } from "../db/settings.ts";
import { effectiveTopicRoot, parseTopic } from "../meshtastic/topic.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { mqttFor } from "./tx.ts";
import type { TxTransport } from "../tx/transport.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// Stable contract version for the JSON payload. Add-only: new fields may appear, existing ones
// never change meaning or type without a version bump. Mirrors /api/v1/stats.
const SCHEMA_VERSION = 1;

// Meshtastic modem-preset display names. A channel that carries one of these names but has no
// configured key of its own uses the well-known default key by firmware convention, so it counts
// as a public channel. A channel with an explicitly configured key is judged by that key instead
// (see isPublicChannel), so a private channel that happens to be named like a preset is excluded.
const PRESET_PUBLIC_NAMES = new Set([
  "LongFast", "LongSlow", "LongModerate", "LongTurbo",
  "MediumFast", "MediumSlow", "ShortFast", "ShortSlow", "ShortTurbo", "VeryLongSlow",
]);

// The 16-byte expansion of the Meshtastic default/basic key (base64 "1PG7OiApB1nwvP+rz05pAQ==").
const DEFAULT_KEY_HEX = "d4f1bb3a20290759f0bcffabcf4e6901";

/** True only for the PUBLIC default channel key: the 1-byte selector [1] (base64 "AQ==") or the
 * full 16-byte default key. A blank key (unencrypted) or any other PSK is NOT the public default,
 * so the feed never republishes a private/community channel even when HopWatch holds its key. */
function isPublicKey(b64: string): boolean {
  if (!b64) return false;
  let buf: Buffer;
  try { buf = Buffer.from(b64, "base64"); } catch { return false; }
  if (buf.length === 1) return buf[0] === 1;
  return buf.equals(Buffer.from(DEFAULT_KEY_HEX, "hex"));
}

interface FeedCfg {
  enabled: boolean; armed: boolean; broker_id: string; topic_suffix: string;
  require_ok_to_mqtt: boolean; public_only: boolean; all_regions: boolean; include_reactions: boolean;
  channels: string[]; max_text_chars: number;
}

interface Row {
  id: number; from_node_id: number; channel_id: string | null; source_topic: string | null; body: string;
  observed_at: string; source_packet_id: number; is_reaction: number | null;
  reply_to_packet_id: number | null; long_name: string | null; short_name: string | null;
  mesh_packet_id: number | null; ok_to_mqtt: number | null;
  rx_snr: number | null; rx_rssi: number | null; hop_start: number | null; hop_limit: number | null;
  gateway_id: number | null;
}

/** The on-air channel name to display in the feed. The MQTT topic's `<CHANNEL>` segment is the
 * firmware's display name (a default-key primary channel shows as its modem preset, e.g. LongFast),
 * which is what a consumer expects to see, so prefer it; fall back to the stored channel id (what RF
 * receptions already resolve to the preset name) when the topic carries no channel. */
function displayChannel(sourceTopic: string | null, channelId: string): string {
  if (sourceTopic) {
    const c = parseTopic(sourceTopic).channelId;
    if (c) return c;
  }
  return channelId;
}

/**
 * Public decoded-text JSON feed. Re-publishes public-channel TEXT_MESSAGE_APP broadcasts HopWatch
 * has decoded, as compact JSON, to one MQTT broker (feed.broker_id) under <root>/<topic_suffix>, so
 * downstream consumers (Home Assistant, dashboards) get the whole de-duplicated text feed without
 * decrypting themselves. Runs in the worker alongside the RF<->MQTT patcher and shares its MQTT
 * transports.
 *
 * Safety (Rule 2 + Rule 6): off unless feed.enabled AND feed.armed; broadcasts only (never DMs);
 * public-default-key channels only (never a private/community PSK, even one we can read); honours
 * the sender's OK-to-MQTT bit by default; scoped to the feed broker's region (topic root) plus the
 * operator's own RF station node. Each logical message is published at most once (feed_at marker),
 * QoS 0 and not retained, and every publish is audited in bridge_log.
 */
export async function runTextFeed(cfg: HopWatchConfig, transports: { mqtt: TxTransport; node: TxTransport }): Promise<number> {
  const f = cfg.feed as unknown as FeedCfg;
  if (!f.enabled || !f.armed || !f.broker_id) return 0;

  // The feed broker's topic root is both where we publish and how we scope the region. Without a
  // resolvable root there is nowhere to publish and no region to filter to, so do nothing.
  const broker = (await getRuntimeBrokers()).find((b) => b.id === f.broker_id);
  if (!broker) return 0;
  const root = effectiveTopicRoot(broker.root_topic, broker.topics).root;
  if (!root) return 0;
  const suffix = (f.topic_suffix || "hopwatch/v1/text").replace(/^\/+|\/+$/g, "");
  const destTopic = `${root}/${suffix}`;
  const maxChars = Math.min(512, Math.max(1, Number(f.max_text_chars) || 240));

  // Public-channel membership: configured keys that are the public default, by their channel name.
  const keys = await getChannelKeys();
  const publicNames = new Set(keys.filter((k) => isPublicKey(k.key)).map((k) => k.name));
  const configuredNames = new Set(keys.map((k) => k.name));
  const isPublicChannel = (name: string): boolean =>
    configuredNames.has(name) ? publicNames.has(name) : PRESET_PUBLIC_NAMES.has(name);

  // Candidate broadcasts not yet considered. Scope: all public broadcasts HopWatch decoded
  // (all_regions), or only those on the publish broker's topic region plus the operator's own RF
  // node. The representative reception (preferring an RF-direct copy, else the earliest) supplies
  // the signal/hops/gateway reported for the message.
  const regionClause = f.all_regions
    ? ""
    : "AND (tm.source_topic LIKE CONCAT(?, '/%') OR tm.source_broker_id = 'node')";
  const regionParams = f.all_regions ? [] : [root];
  const rows = await query<Row>(
    `SELECT tm.id, tm.from_node_id, tm.channel_id, tm.source_topic, tm.body, tm.observed_at, tm.source_packet_id,
            tm.is_reaction, tm.reply_to_packet_id, n.long_name, n.short_name,
            p.mesh_packet_id, p.ok_to_mqtt,
            r.rx_snr, r.rx_rssi, r.hop_start, r.hop_limit, r.gateway_id
       FROM text_message tm
       LEFT JOIN nodes n ON n.node_id = tm.from_node_id
       LEFT JOIN packets p ON p.id = tm.source_packet_id
       LEFT JOIN receptions r ON r.id = (
         SELECT r2.id FROM receptions r2
          WHERE r2.packet_id = tm.source_packet_id
          ORDER BY (r2.reception_class IN ('rf_direct','rf_direct_low_conf')) DESC, r2.rx_time ASC
          LIMIT 1
       )
      WHERE tm.feed_at IS NULL
        AND tm.to_node_id IS NULL
        AND tm.source_packet_id IS NOT NULL
        AND tm.observed_at >= (UTC_TIMESTAMP() - INTERVAL 15 MINUTE)
        ${regionClause}
      ORDER BY tm.id ASC LIMIT 200`,
    regionParams,
  );
  if (rows.length === 0) return 0;

  let published = 0;
  for (const row of rows) {
    const chan = row.channel_id ?? "";
    // Eligibility and key lookup run on the stored channel id (what the admin allowlist and the
    // channel keys are keyed on); the published/logged name is normalised to the on-air preset name.
    const chanDisplay = displayChannel(row.source_topic, chan);
    // Eligibility filters. Anything we drop here is still marked handled so it is not re-scanned.
    const reaction = !!row.is_reaction;
    const eligible =
      !!row.mesh_packet_id &&                                           // need a mesh packet id to dedupe on
      (!f.public_only || isPublicChannel(chan)) &&                      // public-default-key channels only
      (f.channels.length === 0 || f.channels.includes(chan)) &&         // channel allowlist (empty = all)
      (!f.require_ok_to_mqtt || !!row.ok_to_mqtt) &&                     // sender consent
      (f.include_reactions || !reaction);                               // optionally drop tapbacks
    if (!eligible) { await mark(row.id); continue; }

    const hops = row.hop_start != null && row.hop_limit != null
      ? Math.max(0, row.hop_start - row.hop_limit) : null;
    const payload = {
      schema_version: SCHEMA_VERSION,
      id: row.mesh_packet_id! >>> 0,
      time: isoUtc(row.observed_at),
      from: formatNodeId(row.from_node_id),
      long_name: row.long_name ?? null,
      short_name: row.short_name ?? null,
      channel: chanDisplay,
      text: Array.from(row.body ?? "").slice(0, maxChars).join(""),
      hops,
      snr: row.rx_snr != null ? Number(row.rx_snr) : null,
      rssi: row.rx_rssi != null ? Number(row.rx_rssi) : null,
      gateway: row.gateway_id ? formatNodeId(row.gateway_id) : null,
      reply_id: row.reply_to_packet_id ? row.reply_to_packet_id >>> 0 : null,
      emoji: reaction,
    };

    try {
      await mqttFor(f.broker_id, transports.mqtt).publish(destTopic, Buffer.from(JSON.stringify(payload)));
    } catch (e) {
      // Transient broker outage: leave this row unmarked so it retries next tick (until it ages out
      // of the 15-minute window), and stop hammering the broker for the rest of this run.
      console.error(`[feed] publish failed, will retry: ${(e as Error).message}`);
      break;
    }
    await logFeed(f.broker_id, destTopic, row, chanDisplay);
    await mark(row.id);
    published++;
  }
  return published;
}

async function mark(id: number): Promise<void> {
  await query(`UPDATE text_message SET feed_at=? WHERE id=?`, [toMysqlUtc(new Date()), id]);
}

/** Record a feed publish in bridge_log (direction 'feed'), so /admin/bridge shows every republish
 * path alongside the federation bridge and the RF<->MQTT patcher. */
async function logFeed(toBroker: string, destTopic: string, row: Row, channel: string): Promise<void> {
  await getPool()
    .execute(
      `INSERT INTO bridge_log (bridged_at, direction, from_broker, to_broker, from_node_id, mesh_packet_id, channel_id, topic, dest_topic)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      [toMysqlUtc(new Date()), "feed", "hopwatch", toBroker, row.from_node_id, row.mesh_packet_id ?? 0, channel || null, "text_feed", destTopic.slice(0, 255)],
    )
    .catch((e) => console.error(`[feed] bridge_log failed: ${(e as Error).message}`));
}

/** MySQL UTC datetime string ("YYYY-MM-DD HH:MM:SS.mmm") to ISO8601 UTC. */
function isoUtc(mysqlUtc: string): string {
  try { return new Date(mysqlUtc.replace(" ", "T") + "Z").toISOString(); } catch { return mysqlUtc; }
}
