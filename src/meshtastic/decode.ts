// ServiceEnvelope decode + normalization.
//
// INTEGRATION POINT: this is the ONLY file that touches the protobuf library.
// It targets @meshtastic/protobufs (protobuf-es v2) accessed dynamically and
// defensively (`any`-typed) so a version bump in the schema package's export
// names is a localized fix. Everything downstream consumes NormalizedEnvelope.
import { fromBinary } from "@bufbuild/protobuf";
import { expandKey, decryptPayload, channelHash } from "./crypto.ts";
import { portName, PORT_NAMES } from "./portnum.ts";
import type { TopicInfo } from "./topic.ts";
import {
  type NormalizedEnvelope,
  type NormalizedPacket,
  type DecodedData,
  type ParsedPayload,
  parseNodeId,
} from "./types.ts";

export class DecodeError extends Error {}

// Lazily loaded protobuf schemas. Cast to any: exact export names are pinned by
// the installed @meshtastic/protobufs version and verified at integration time.
let pbMod: any = null;
async function pb(): Promise<any> {
  if (!pbMod) pbMod = await import("@meshtastic/protobufs");
  return pbMod;
}

// Decode protobuf binary against an (untyped) schema, returning a plain any object.
// Confines the protobuf-es generic typing to a single spot; callers work with `any`.
function decodeBin(schema: any, bytes: Uint8Array): any {
  return fromBinary(schema, bytes);
}

export interface ChannelKey {
  name: string;
  key: string;
}

/**
 * Decode a protobuf ServiceEnvelope. Throws DecodeError on malformed bytes.
 * Undecryptable packets return with `packet.encrypted` set and `decoded` null.
 */
export async function decodeProtobufEnvelope(
  bytes: Uint8Array,
  topic: TopicInfo,
  keys: ChannelKey[],
): Promise<NormalizedEnvelope> {
  const m = await pb();
  let env: any;
  try {
    env = decodeBin(m.Mqtt.ServiceEnvelopeSchema, bytes);
  } catch (e) {
    throw new DecodeError(`ServiceEnvelope decode failed: ${(e as Error).message}`);
  }
  if (!env?.packet) throw new DecodeError("ServiceEnvelope has no packet");

  const p = env.packet;
  const gatewayId = parseNodeId(env.gatewayId) || topic.gatewayIdFromTopic || 0;
  const packet = buildPacketFields(p);
  // The envelope's channel_id is needed BEFORE the decrypt attempt: "PKI" tells us the payload is
  // not channel-encrypted at all. Both string fields have implicit presence, so an absent one
  // decodes as "" rather than undefined; fall through on empty, not just on null.
  const envChannelId = env.channelId || topic.channelId || null;
  const channelName = await attachPayload(packet, p, keys, m, envChannelId);
  const channelId = envChannelId ?? channelName ?? "";
  return { gatewayId, channelId, packet, fromJson: false };
}

/** Normalize the scalar fields of a raw MeshPacket (shared by the MQTT and RF paths). Leaves
 * decoded/encrypted for attachPayload to fill. */
function buildPacketFields(p: any): NormalizedPacket {
  // rx_rssi / rx_snr / hop_start are proto3 IMPLICIT-presence scalars: an omitted field decodes
  // as 0, indistinguishable at the protobuf layer from a literal 0. So "0" has to be read as
  // "not reported" using domain knowledge, or these can never be null and the classifier's
  // no-RF-metadata and no-hop-header branches become unreachable.
  //
  // A LoRa gateway that actually heard a packet always reports a negative rx_rssi (roughly -30
  // to -130 dBm). rx_rssi == 0 therefore means the publisher attached no RF metadata at all,
  // i.e. an MQTT-injected copy rather than an on-air reception. rx_snr of exactly 0.0 is
  // treated as absent only when rx_rssi is absent too, since a real reception can round to 0 dB.
  const rssiRaw = Number(p.rxRssi ?? 0);
  const snrRaw = Number(p.rxSnr ?? 0);
  const rxRssi = rssiRaw === 0 ? null : rssiRaw;
  const rxSnr = rxRssi === null && snrRaw === 0 ? null : snrRaw;
  return {
    meshPacketId: Number(p.id ?? 0) >>> 0,
    from: Number(p.from ?? 0) >>> 0,
    to: p.to !== undefined ? Number(p.to) >>> 0 : null,
    channel: p.channel !== undefined ? Number(p.channel) : null,
    // Set by attachPayload once the payload variant is known.
    channelIsHash: false,
    // hop_start only exists from firmware 2.3.0; older senders omit it, which also decodes as 0.
    // Report 0 as "absent" so the classifier falls through to its relay_node / low-confidence
    // branch instead of computing a bogus authoritative zero-hop. See classify.ts.
    hopStart: Number(p.hopStart ?? 0) === 0 ? null : Number(p.hopStart),
    hopLimit: p.hopLimit !== undefined && p.hopLimit !== null ? Number(p.hopLimit) : null,
    relayNode: p.relayNode !== undefined && p.relayNode !== null ? Number(p.relayNode) : null,
    rxRssi,
    rxSnr,
    rxTimeMs: p.rxTime ? Number(p.rxTime) * 1000 : null,
    wantAck: Boolean(p.wantAck),
    viaMqtt: Boolean(p.viaMqtt),
    // Set from Data.bitfield by attachPayload once the inner Data is available. Stays false for
    // packets we cannot decrypt: the bit is inside the ciphertext, so "unknown" must read as
    // "not approved" and fail the bridge's require_ok_to_mqtt gate closed.
    okToMqtt: false,
    // MeshPacket.pki_encrypted / public_key: a PKI (Curve25519 + AES-CCM) DM. No channel PSK can
    // ever open it, so attachPayload must not run the key loop over it.
    pkiEncrypted: Boolean(p.pkiEncrypted),
    publicKey: p.publicKey?.length ? new Uint8Array(p.publicKey) : null,
    encrypted: null,
    cipherText: null,
    decoded: null,
  };
}

/** ServiceEnvelope.channel_id a gateway uses for PKI-encrypted traffic instead of a channel name
 * (firmware MQTT.cpp: `isPKIEncrypted ? "PKI" : channels.getGlobalId(chIndex)`). */
export const PKI_CHANNEL_ID = "PKI";

/** Fill packet.decoded/encrypted from a MeshPacket's payloadVariant. Returns the matched
 * channel name when a key decrypted the payload (used to derive channelId on the RF path,
 * which has no MQTT topic), else null. */
async function attachPayload(
  packet: NormalizedPacket,
  p: any,
  keys: ChannelKey[],
  m: any,
  channelId: string | null,
): Promise<string | null> {
  const variant = p.payloadVariant;
  if (variant?.case === "decoded" && variant.value) {
    packet.decoded = await normalizeData(variant.value, m);
    packet.okToMqtt = okToMqttOf(packet.decoded);
  } else if (variant?.case === "encrypted" && variant.value) {
    const enc: Uint8Array = variant.value;
    // An encrypted-variant packet carries the channel HASH here, not an index.
    packet.channelIsHash = true;
    // Always keep the ciphertext, even when a key opens it: an accept is pinned permanently by the
    // packets upsert and nothing re-decodes, so this is the only copy that could ever correct one.
    packet.cipherText = enc;
    // A PKI DM is Curve25519 + AES-CCM. Running every channel PSK over it cannot succeed and can
    // only produce a false accept, so skip the key loop entirely and leave it as ciphertext.
    if (packet.pkiEncrypted || channelId === PKI_CHANNEL_ID) {
      packet.encrypted = enc;
      return null;
    }
    const dec = tryDecrypt(enc, packet.meshPacketId, packet.from, keys, m, packet.channel);
    if (dec) {
      packet.decoded = dec.data;
      packet.okToMqtt = okToMqttOf(dec.data);
      return dec.keyName;
    }
    packet.encrypted = enc;
  }
  return null;
}

/** Data.bitfield bit 0 = sender approved MQTT upload (upstream mesh.proto: "user approval for
 * MQTT upload"). Older firmware omits the field entirely, which reads as 0 / not approved. */
function okToMqttOf(d: DecodedData): boolean {
  return (d.bitfield & 1) === 1;
}

export type NodeFrame =
  | { kind: "myInfo"; myNodeNum: number }
  | { kind: "adminMetadata"; from: number; firmwareVersion?: string; hwModel?: string; role?: string }
  // The node's own channel table and modem preset, from the want_config dump the RX stream already
  // receives. Needed to name the channel of a DECODED RF packet: the node decrypts before handing a
  // packet to the stream API and rewrites MeshPacket.channel to the local channel INDEX
  // (Router.cpp: `p->channel = chIndex; // change to store the index instead of the hash`), so the
  // index is all we get and only this table turns it into the channel identity everything
  // downstream keys on.
  | { kind: "channel"; index: number; name: string; role: number }
  | { kind: "modemPreset"; preset: string | undefined; usePreset: boolean }
  | { kind: "packet"; env: NormalizedEnvelope };

/** Index -> channel wire name, as learned from the station node's own config dump. */
export type NodeChannelNames = Map<number, string>;

/** Decode one FromRadio frame from the station node's live stream. Returns the node's own id
 * (myInfo, sent once after want_config), a channel/config table entry, or a received RF packet
 * normalized exactly like the MQTT path so it flows through the same ingest pipeline. The caller
 * tags transport=rf. */
export async function decodeNodeFrame(
  bytes: Uint8Array,
  keys: ChannelKey[],
  myNodeNum: number,
  channelNames?: NodeChannelNames,
): Promise<NodeFrame | null> {
  const m = await pb();
  let fr: any;
  try { fr = decodeBin(m.Mesh.FromRadioSchema, bytes); } catch { return null; }
  const v = fr?.payloadVariant;
  if (v?.case === "myInfo") return { kind: "myInfo", myNodeNum: Number(v.value?.myNodeNum ?? 0) >>> 0 };
  if (v?.case === "channel" && v.value) {
    const c = v.value;
    return { kind: "channel", index: Number(c.index ?? 0), name: String(c.settings?.name ?? ""), role: Number(c.role ?? 0) };
  }
  if (v?.case === "config" && v.value?.payloadVariant?.case === "lora") {
    const lora = v.value.payloadVariant.value ?? {};
    return {
      kind: "modemPreset",
      preset: enumName(m?.Config?.Config_LoRaConfig_ModemPreset, lora.modemPreset) ?? undefined,
      usePreset: !!lora.usePreset,
    };
  }
  if (v?.case !== "packet" || !v.value) return null;
  const p = v.value;

  // Remote-admin scanner: a get_device_metadata_response addressed to us means the sender let us
  // admin it. The node already PKI/channel-decrypted it for itself, so the payload is plain here.
  try {
    const dv = p.payloadVariant;
    if (dv?.case === "decoded" && Number(dv.value?.portnum) === 6 && dv.value?.payload?.length && Number(p.to) >>> 0 === (myNodeNum >>> 0)) {
      const admin = decodeBin(m.Admin.AdminMessageSchema, dv.value.payload);
      const pv = admin?.payloadVariant;
      if (pv?.case === "getDeviceMetadataResponse") {
        const md = pv.value ?? {};
        return {
          kind: "adminMetadata", from: Number(p.from ?? 0) >>> 0,
          firmwareVersion: md.firmwareVersion ? String(md.firmwareVersion) : undefined,
          hwModel: enumName(m?.Mesh?.HardwareModel, md.hwModel),
          role: enumName(m?.Config?.Config_DeviceConfig_Role, md.role),
        };
      }
    }
  } catch { /* not an admin frame: fall through to normal packet handling */ }

  const packet = buildPacketFields(p);
  // An RF frame has no envelope, so there is no channel_id to consult; pkiEncrypted still is.
  const decodedByNode = p.payloadVariant?.case === "decoded";
  const channelName = await attachPayload(packet, p, keys, m, null);
  // Channel identity, in order of authority:
  //  1. the key that decrypted it (only possible for a frame the node could NOT decrypt itself);
  //  2. PKI, which the node flags and which has no channel;
  //  3. the node's own channel table, indexed by MeshPacket.channel, which the firmware rewrote to
  //     the local channel index when it decrypted the packet for us.
  // (3) is the normal case and used to be missing entirely, so every packet the station node could
  // decrypt landed with channel_id NULL. That is not cosmetic: the sanctioned RF->MQTT patcher looks
  // the channel key up by name, so a NULL meant "no key for channel (none)" and it refused to uplink
  // every genuinely RF-only message, which is the one case the patcher exists for.
  let channelId = channelName ?? "";
  if (!channelId && decodedByNode) {
    if (packet.pkiEncrypted) channelId = PKI_CHANNEL_ID;
    else if (packet.channel !== null) channelId = channelNames?.get(packet.channel) ?? "";
  }
  return { kind: "packet", env: { gatewayId: myNodeNum >>> 0, channelId, packet, fromJson: false } };
}

interface KeyCandidate {
  name: string;
  /** null for a zero-length PSK: an UNENCRYPTED channel, whose payload is already plaintext. */
  expanded: Buffer | null;
  /** The 8-bit hash a sender puts in MeshPacket.channel for this (name, PSK) pair. */
  hash: number;
}

/**
 * Recover the inner Data from an encrypted payload variant.
 *
 * The firmware never guesses a key. Router::perhapsDecode tries a channel only when
 * Channels::decryptForHash finds `getHash(chIndex) == p->channel`, and then accepts the plaintext
 * on nothing more than "parses as Data with a portnum other than UNKNOWN_APP". That identity check
 * is what makes the loose acceptance test safe, and the byte it needs is on the wire for every
 * encrypted-variant uplink: MQTT.cpp publishes `mp_encrypted`, a copy Router::handleReceived took
 * BEFORE decryption, so its `channel` is still the 8-bit hash rather than the index that
 * perhapsDecode later writes there.
 *
 * Guessing by payload shape instead is measurably wrong. AES-CTR never fails and protobuf-es
 * decodes wrong-key bytes without throwing, so garbage whose portnum happens to land in PORT_NAMES
 * with an empty payload was accepted as a decode in roughly 1 of 4,000-17,000 attempts per
 * configured key (measured against this repo's own code; every observed false accept came through
 * that empty-payload branch). A false accept is irreversible: the packets upsert pins
 * decode_status='decoded' and port_num, and applyIdentity can write fabricated names over real
 * ones in an authoritative table.
 *
 * So: try only the keys whose hash matches the wire byte, with the firmware's own acceptance test.
 * A hash match implies the channel NAME and PSK are both right, so if such a key fails to yield a
 * Data the packet is genuinely undecodable and there is nothing to be gained by guessing. Guessing
 * is reserved for the case where no configured key matches the hash at all (an older or rewritten
 * publisher, or a channel byte we cannot interpret), and even then the empty-payload branch demands
 * want_response, which the request ports that legitimately carry no payload all set.
 */
function tryDecrypt(
  enc: Uint8Array,
  packetId: number,
  from: number,
  keys: ChannelKey[],
  m: any,
  channelByte: number | null,
): { data: DecodedData; keyName: string } | null {
  const candidates: KeyCandidate[] = keys.map((k) => {
    const expanded = expandKey(k.key);
    return { name: k.name, expanded, hash: channelHash(k.name, expanded) };
  });
  const attempt = (c: KeyCandidate, strict: boolean): { data: DecodedData; keyName: string } | null => {
    // A null key is a PSK-less channel: CryptoEngine::encryptPacket is a no-op under
    // `if (key.length > 0)`, so the "encrypted" payload is already the plaintext Data protobuf.
    // Ham mode reaches HopWatch this way, and previously could never be decoded at all.
    const plain = c.expanded ? decryptPayload(enc, c.expanded, packetId, from) : Buffer.from(enc);
    if (!plain) return null;
    try {
      const data = decodeBin(m.Mesh.DataSchema, plain);
      if (!data) return null;
      const portnum = Number(data.portnum ?? 0);
      // The firmware's test: decodes as Data, portnum is not UNKNOWN_APP (0). 511 is the highest
      // value portnums.proto defines (PRIVATE_APP 256 .. ATAK_FORWARDER 257, max 511).
      if (portnum < 1 || portnum > 511) return null;
      if (strict) {
        const payload: Uint8Array | undefined = data.payload;
        if (!payload?.length && !(portnum in PORT_NAMES && Boolean(data.wantResponse))) return null;
      }
      return { data: normalizeDataSync(data, m), keyName: c.name };
    } catch {
      // wrong key -> garbage -> not a valid Data protobuf; try the next candidate
      return null;
    }
  };

  const matching = channelByte === null ? [] : candidates.filter((c) => c.hash === channelByte);
  for (const c of matching) {
    const hit = attempt(c, false);
    if (hit) return hit;
  }
  if (matching.length > 0) return null;
  for (const c of candidates) {
    const hit = attempt(c, true);
    if (hit) return hit;
  }
  return null;
}

async function normalizeData(data: any, m: any): Promise<DecodedData> {
  return normalizeDataSync(data, m);
}

function normalizeDataSync(data: any, m: any): DecodedData {
  const portnum = Number(data.portnum ?? 0);
  const payload: Uint8Array = data.payload ?? new Uint8Array();
  return {
    portnum,
    portName: portName(portnum),
    payload,
    bitfield: Number(data.bitfield ?? 0) >>> 0,
    parsed: parsePayload(portnum, payload, m, data),
  };
}

function parsePayload(portnum: number, payload: Uint8Array, m: any, data?: any): ParsedPayload | null {
  try {
    switch (portnum) {
      case 1: { // TEXT_MESSAGE_APP
        // Data.reply_id (field 7) and Data.emoji (field 8): a non-zero emoji means the payload is
        // a tapback reaction, not a typed message. Both are 0 when absent.
        const replyId = Number(data?.replyId ?? 0) >>> 0;
        const emoji = Number(data?.emoji ?? 0) >>> 0;
        return {
          kind: "text", text: Buffer.from(payload).toString("utf8"),
          replyToPacketId: replyId || undefined,
          isReaction: emoji !== 0 ? true : undefined,
        };
      }
      case 12: {
        // KEY_VERIFICATION_APP -> KeyVerification. Stage from which hash is present: neither is the
        // requester's opening message, hash2 alone is the responder's intermediary, and hash1 is the
        // requester's closing authoritative hash. A nonce that never reaches `final` is an
        // abandoned or failed verification, which is the signal worth surfacing.
        const kv = decodeBin(m.Mesh.KeyVerificationSchema, payload);
        const h1 = (kv?.hash1 as Uint8Array | undefined)?.length ?? 0;
        const h2 = (kv?.hash2 as Uint8Array | undefined)?.length ?? 0;
        return {
          kind: "keyverification",
          nonce: Number(kv?.nonce ?? 0),
          stage: h1 > 0 ? "final" : h2 > 0 ? "response" : "request",
        };
      }
      case 10:
      case 11: {
        // DETECTION_SENSOR_APP / ALERT_APP: a UTF-8 body, like port 1. The firmware's own
        // "is this a text message" test covers all three ports, so nothing extra is needed to read
        // them; HopWatch simply counted the port and dropped the body.
        return {
          kind: "sensor",
          sensorKind: portnum === 10 ? "detection" : "alert",
          text: Buffer.from(payload).toString("utf8"),
        };
      }
      case 3: {
        // POSITION_APP
        const pos = decodeBin(m.Mesh.PositionSchema, payload);
        if (pos.latitudeI === undefined && pos.longitudeI === undefined) return rawOf(payload);
        return {
          kind: "position",
          latitude: Number(pos.latitudeI ?? 0) / 1e7,
          longitude: Number(pos.longitudeI ?? 0) / 1e7,
          altitudeM: pos.altitude !== undefined ? Number(pos.altitude) : null,
          precisionBits: pos.precisionBits !== undefined ? Number(pos.precisionBits) : null,
        };
      }
      case 4: {
        // NODEINFO_APP -> User
        const u = decodeBin(m.Mesh.UserSchema, payload);
        return {
          kind: "nodeinfo",
          longName: u.longName ?? undefined,
          shortName: u.shortName ?? undefined,
          hwModel: enumName(m?.Mesh?.HardwareModel, u.hwModel),
          role: enumName(m?.Config?.Config_DeviceConfig_Role ?? m?.Mesh?.Config_DeviceConfig_Role, u.role),
          publicKey: u.publicKey && u.publicKey.length ? u.publicKey : undefined,
          isLicensed: u.isLicensed === undefined ? undefined : Boolean(u.isLicensed),
        };
      }
      case 67: {
        // TELEMETRY_APP
        const t = decodeBin(m.Telemetry.TelemetrySchema, payload);
        return { kind: "telemetry", metrics: flattenTelemetry(t) };
      }
      case 73: {
        // MAP_REPORT_APP -> MapReport (sent on the `/2/map/` topic, always decoded/plaintext).
        const r = decodeBin(m.Mqtt.MapReportSchema, payload);
        const lat = r.latitudeI !== undefined && Number(r.latitudeI) !== 0 ? Number(r.latitudeI) / 1e7 : null;
        const lon = r.longitudeI !== undefined && Number(r.longitudeI) !== 0 ? Number(r.longitudeI) / 1e7 : null;
        return {
          kind: "mapreport",
          longName: r.longName ? String(r.longName) : undefined,
          shortName: r.shortName ? String(r.shortName) : undefined,
          hwModel: enumName(m?.Mesh?.HardwareModel, r.hwModel),
          role: enumName(m?.Config?.Config_DeviceConfig_Role, r.role),
          firmwareVersion: r.firmwareVersion ? String(r.firmwareVersion) : undefined,
          region: enumName(m?.Config?.Config_LoRaConfig_RegionCode, r.region),
          modemPreset: enumName(m?.Config?.Config_LoRaConfig_ModemPreset, r.modemPreset),
          hasDefaultChannel: r.hasDefaultChannel === undefined ? undefined : Boolean(r.hasDefaultChannel),
          latitude: lat,
          longitude: lon,
          altitudeM: r.altitude !== undefined ? Number(r.altitude) : null,
          precisionBits: r.positionPrecision !== undefined ? Number(r.positionPrecision) : null,
          numOnlineLocalNodes: r.numOnlineLocalNodes !== undefined ? Number(r.numOnlineLocalNodes) : null,
        };
      }
      case 71: {
        // NEIGHBORINFO_APP -> NeighborInfo
        const ni = decodeBin(m.Mesh.NeighborInfoSchema, payload);
        return {
          kind: "neighborinfo",
          node: Number(ni.nodeId ?? 0) >>> 0,
          neighbors: (ni.neighbors ?? []).map((x: any) => ({ node: Number(x.nodeId ?? 0) >>> 0, snr: Number(x.snr ?? 0) })),
        };
      }
      case 5: {
        // ROUTING_APP -> Routing. The oneof variant tells ack from NAK: the firmware's sendAckNak
        // always sets error_reason, so `errorReason` with value 0 (Routing.Error.NONE) is an ACK and
        // any other value is a NAK. Data.request_id names the packet being answered; without it the
        // TX outbox could only ask "did any port-5 packet come back", which promoted every in-flight
        // row on one node's ack and counted a delivery FAILURE as success.
        const r = decodeBin(m.Mesh.RoutingSchema, payload);
        const variant = r?.variant?.case ?? null;
        const code = variant === "errorReason" ? Number(r.variant.value ?? 0) : -1;
        return {
          kind: "routing",
          requestId: Number(data?.requestId ?? 0) >>> 0,
          errorCode: code,
          errorName: code >= 0 ? (enumName(m?.Mesh?.Routing_Error, code) ?? String(code)) : null,
          variant,
        };
      }
      case 70: {
        // TRACEROUTE_APP -> RouteDiscovery
        const r = decodeBin(m.Mesh.RouteDiscoverySchema, payload);
        return {
          kind: "traceroute",
          route: (r.route ?? []).map((n: any) => Number(n) >>> 0),
          routeBack: (r.routeBack ?? []).map((n: any) => Number(n) >>> 0),
          snrTowards: (r.snrTowards ?? []).map((n: any) => Number(n)),
          snrBack: (r.snrBack ?? []).map((n: any) => Number(n)),
        };
      }
      default:
        return rawOf(payload);
    }
  } catch {
    return rawOf(payload);
  }
}

function rawOf(payload: Uint8Array): ParsedPayload {
  return { kind: "raw", hex: Buffer.from(payload).toString("hex") };
}

function enumName(enumObj: any, value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (enumObj && typeof enumObj === "object" && enumObj[value] !== undefined) return String(enumObj[value]);
  return String(value);
}

// Canonical metric keys the rest of the app relies on (health score, dashboard, low-battery,
// weather correlation). These aliases are stable; everything else is captured generically so
// we never silently drop a sensor reading again.
const DEVICE_ALIAS: Record<string, string> = {
  batteryLevel: "battery_pct", voltage: "voltage", channelUtilization: "chan_util",
  airUtilTx: "air_util_tx", uptimeSeconds: "uptime",
};
/**
 * EnvironmentMetrics.
 *
 * `voltage` and `current` are NAMESPACED. They are not the device's battery: firmware's INA219,
 * INA226, INA260 and INA3221 sensors all write a measured BUS voltage (a 12 V solar rail, a 5 V USB
 * rail) into environment_metrics.voltage, and the metric name is the only thing distinguishing them
 * downstream. Under the shared name, src/worker/battery.ts fitted its death curve over an INA rail
 * and src/worker/alerts.ts fired battery_threshold on it, so a solar-monitor or weather-station node
 * produced false low-battery alerts and nonsense projected_dead_at values, and its rail voltage
 * overwrote the battery series on the node chart. healthMetrics already gets a `health_` prefix for
 * exactly this reason; this applies the same rule.
 *
 * Historical rows keep the old unprefixed name: renaming them would rewrite recorded observations,
 * and the battery consumers only look at a trailing window, so they self-correct as new data lands.
 */
const ENV_ALIAS: Record<string, string> = {
  temperature: "temperature", relativeHumidity: "humidity", barometricPressure: "pressure",
  voltage: "env_voltage", current: "env_current", iaq: "iaq",
};

function camelToSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Add every finite numeric field of a metrics sub-message, aliasing the canonical keys and
 * snake-casing the rest. Never overwrites an already-set canonical key. */
function addNumericFields(out: Record<string, number>, obj: any, alias: Record<string, string>, prefix = ""): void {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || typeof v === "object" || typeof v === "boolean") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const key = alias[k] ?? prefix + camelToSnake(k);
    if (!(key in out)) out[key] = n;
  }
}

// Capture all sensor telemetry Meshtastic can send: device, environment, power, air quality,
// and health metrics. A telemetry packet carries one variant; support both the bufbuild
// oneof shape (t.variant.{case,value}) and the flat shape (t.deviceMetrics, ...).
export function flattenTelemetry(t: any): Record<string, number> {
  const out: Record<string, number> = {};
  const pick = (name: string) => (t?.variant?.case === name ? t.variant.value : t?.[name]);
  const dm = pick("deviceMetrics"); if (dm) addNumericFields(out, dm, DEVICE_ALIAS);
  const em = pick("environmentMetrics"); if (em) addNumericFields(out, em, ENV_ALIAS);
  const pm = pick("powerMetrics"); if (pm) addNumericFields(out, pm, {});
  const aq = pick("airQualityMetrics"); if (aq) addNumericFields(out, aq, {});
  const hm = pick("healthMetrics"); if (hm) addNumericFields(out, hm, {}, "health_");
  // LocalStats and HostMetrics were dropped entirely. Both need a prefix, not just a pick():
  // LocalStats.uptime_seconds / channel_utilization / air_util_tx would otherwise be swallowed by
  // addNumericFields' "never overwrite a canonical key" guard, or worse pollute the device-metric
  // charts with a different node's view of the same quantities.
  //
  // LocalStats is the richest per-node topology record the mesh emits: that node's own count of
  // online/total nodes, num_tx_relay and num_tx_relay_canceled (which identify de-facto backbone
  // routers even when the role field claims CLIENT), duplicate/bad/dropped packet counters, and
  // noise_floor, a per-site RF noise measurement. HostMetrics marks a node as a meshtasticd/Linux
  // gateway rather than a handheld and carries load averages, free memory and disk. The firmware's
  // JSON serializer downconverts neither, so these arrive only on the protobuf topic.
  const ls = pick("localStats"); if (ls) addNumericFields(out, ls, {}, "ls_");
  const host = pick("hostMetrics"); if (host) addNumericFields(out, host, {}, "host_");
  // Telemetry variant 9. Prefixed like the rest: its counters describe the node's own airtime
  // management, not the mesh-wide quantities the device metrics use the bare names for.
  const tms = pick("trafficManagementStats"); if (tms) addNumericFields(out, tms, {}, "tms_");
  return out;
}

/**
 * Firmware JSON `type` strings that HopWatch does not parse into a typed payload yet, mapped to
 * the PortNum they came from (MeshPacketSerializer emits these alongside the handled types).
 * Recording the port keeps decode_status honest for well-formed traffic.
 */
const JSON_TYPE_PORTS: Record<string, number> = {
  waypoint: 8,
  neighborinfo: 71,
  traceroute: 70,
  paxcounter: 34,
  gpios_changed: 2,
  gpios_read_reply: 2,
};

/**
 * Normalize a JSON-topic message. Meshtastic JSON downlink payloads carry a
 * subset of fields; we map what is present and key it to the same packet model.
 */
export function decodeJsonEnvelope(obj: any, topic: TopicInfo): NormalizedEnvelope {
  const from = parseNodeId(obj.from ?? obj.sender);
  const gatewayId = parseNodeId(obj.sender) || topic.gatewayIdFromTopic || 0;
  const type: string | undefined = obj.type;
  let parsed: ParsedPayload | null = null;
  let portnum = 0;
  if (type === "text") {
    // The firmware emits the body as a bare string; it only becomes an object when the message
    // body was itself valid JSON (the shape sensor bridges and status bots use). Re-stringify
    // that case rather than dropping the message, which the protobuf path decodes fine.
    const body = typeof obj.payload === "string" ? obj.payload
      : typeof obj.payload?.text === "string" ? obj.payload.text
      : obj.payload !== undefined && obj.payload !== null ? JSON.stringify(obj.payload)
      : null;
    if (body !== null) {
      parsed = { kind: "text", text: body };
      portnum = 1;
    }
  } else if (type === "position" && obj.payload) {
    parsed = {
      kind: "position",
      latitude: Number(obj.payload.latitude_i ?? obj.payload.latitude ?? 0) / (obj.payload.latitude_i ? 1e7 : 1),
      longitude: Number(obj.payload.longitude_i ?? obj.payload.longitude ?? 0) / (obj.payload.longitude_i ? 1e7 : 1),
      altitudeM: obj.payload.altitude !== undefined ? Number(obj.payload.altitude) : null,
      // Preserve a deliberately reduced precision instead of erasing it to NULL.
      precisionBits: obj.payload.precision_bits !== undefined ? Number(obj.payload.precision_bits) : null,
    };
    portnum = 3;
  } else if ((type === "detection" || type === "alert") && obj.payload) {
    // The JSON serializer emits the body as `text`, same as a chat message.
    const body = obj.payload.text ?? obj.payload.body;
    parsed = { kind: "sensor", sensorKind: type === "detection" ? "detection" : "alert", text: typeof body === "string" ? body : JSON.stringify(body ?? "") };
    portnum = type === "detection" ? 10 : 11;
  } else if (type === "telemetry" && obj.payload) {
    parsed = { kind: "telemetry", metrics: numericFields(obj.payload) };
    portnum = 67;
  } else if (type === "nodeinfo" && obj.payload) {
    parsed = {
      kind: "nodeinfo",
      longName: obj.payload.longname ?? obj.payload.longName,
      shortName: obj.payload.shortname ?? obj.payload.shortName,
      hwModel: obj.payload.hardware !== undefined ? String(obj.payload.hardware) : undefined,
      isLicensed: (obj.payload.islicensed ?? obj.payload.isLicensed) === undefined ? undefined : Boolean(obj.payload.islicensed ?? obj.payload.isLicensed),
    };
    portnum = 4;
  } else if (type && type in JSON_TYPE_PORTS) {
    // Recognized firmware message types we do not parse yet. Still record the port so the packet
    // is not persisted as decode_status='malformed' with a NULL port: it is well-formed, just
    // unparsed, and mislabelling it inflates the malformed-packet health signal and hides it
    // from every port-filtered view.
    portnum = JSON_TYPE_PORTS[type]!;
    parsed = null;
  }

  // Field names come from the firmware's MeshPacketSerializer: it emits `hops_away` and
  // `hop_start` (both only when hops_away >= 0), `rssi`/`snr` (only when non-zero), `want_ack`,
  // `timestamp`, `id`, `to`, `from`, `channel`, `sender`. It never emits `hop_limit` or
  // `relay_node`, so hop_limit has to be derived from hop_start - hops_away; reading a
  // `hop_limit` key left every JSON reception without a hop count and therefore permanently
  // "low confidence", including packets the gateway explicitly reported as several hops away.
  const hopStart = obj.hop_start !== undefined ? Number(obj.hop_start) : null;
  const hopsAway = obj.hops_away !== undefined ? Number(obj.hops_away) : null;
  const packet: NormalizedPacket = {
    meshPacketId: Number(obj.id ?? 0) >>> 0,
    from,
    to: obj.to !== undefined ? Number(obj.to) >>> 0 : null,
    channel: obj.channel !== undefined ? Number(obj.channel) : null,
    hopStart,
    hopLimit: hopStart !== null && hopsAway !== null ? hopStart - hopsAway : null,
    // Not present in the firmware's JSON projection at all.
    relayNode: null,
    rxRssi: obj.rssi !== undefined ? Number(obj.rssi) : null,
    rxSnr: obj.snr !== undefined ? Number(obj.snr) : null,
    rxTimeMs: obj.timestamp !== undefined ? Number(obj.timestamp) * 1000 : null,
    wantAck: Boolean(obj.want_ack),
    viaMqtt: true,
    // The JSON topic flattens Data.bitfield to a top-level boolean; absent = not approved.
    okToMqtt: obj.ok_to_mqtt !== undefined ? Boolean(obj.ok_to_mqtt) : false,
    encrypted: null,
    // The JSON projection is the gateway's own decode, so `channel` is the gateway's local index,
    // never a hash. It carries no ciphertext, and the firmware's MeshPacketSerializer emits no
    // pki_encrypted/public_key fields.
    channelIsHash: false,
    cipherText: null,
    pkiEncrypted: false,
    publicKey: null,
    decoded: portnum
      ? {
          portnum, portName: portName(portnum), payload: new Uint8Array(),
          bitfield: obj.ok_to_mqtt ? 1 : 0,
          parsed,
        }
      : null,
  };

  return { gatewayId, channelId: topic.channelId ?? "", packet, fromJson: true };
}

// The firmware's JSON telemetry uses the raw proto field names (battery_level,
// channel_utilization, ...), while the protobuf path aliases them to HopWatch's canonical metric
// keys via DEVICE_ALIAS/ENV_ALIAS. Without this mapping a node observed only over the /2/json/
// topic writes metric names that no alert, rollup or chart queries, so its battery and channel
// utilization are silently invisible.
/**
 * JSON-topic metric names -> HopWatch's canonical names.
 *
 * The firmware's MeshPacketSerializer flattens the telemetry variant, so the JSON side must use the
 * same canonical names as the protobuf side or a metric is stored under a key no query reads. The
 * power and particulate entries were exactly that: emitted, stored, and invisible.
 */
const JSON_METRIC_ALIAS: Record<string, string> = {
  battery_level: "battery_pct",
  channel_utilization: "chan_util",
  air_util_tx: "air_util_tx",
  uptime_seconds: "uptime",
  relative_humidity: "humidity",
  barometric_pressure: "pressure",
  // PowerMetrics: the protobuf path snake-cases these to the same names, so align explicitly.
  ch1_voltage: "ch1_voltage", ch1_current: "ch1_current",
  ch2_voltage: "ch2_voltage", ch2_current: "ch2_current",
  ch3_voltage: "ch3_voltage", ch3_current: "ch3_current",
  // AirQualityMetrics particulate counts, likewise.
  pm10_standard: "pm10_standard", pm25_standard: "pm25_standard", pm100_standard: "pm100_standard",
  pm10_environmental: "pm10_environmental", pm25_environmental: "pm25_environmental",
  pm100_environmental: "pm100_environmental",
};

function numericFields(obj: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out[JSON_METRIC_ALIAS[k] ?? k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Station-node config read (FromRadio stream). A node dumps its state as a series of
// FromRadio messages in response to want_config_id; we normalize each into a small tagged
// union for src/node/readconfig.ts. Defensive throughout: a schema field rename degrades to
// a partial result rather than throwing.
// ---------------------------------------------------------------------------
export type FromRadioMsg =
  | { kind: "myInfo"; myNodeNum: number }
  | { kind: "metadata"; firmwareVersion: string; hwModel?: string; role?: string; hasWifi: boolean; hasBluetooth: boolean }
  // `raw` is the section message exactly as the node sent it, kept alongside the normalized
  // projection so a write can be a read-modify-write. The firmware assigns a set_config section
  // WHOLESALE (AdminModule.cpp: `config.lora = validatedLora`, `config.position =
  // c.payload_variant.position`, `moduleConfig.mqtt = c.payload_variant.mqtt`), so any field
  // rebuilt from the projection alone reverts to its protobuf default on the device. Never
  // serialize `raw` to a client; it is a protobuf message, not JSON.
  | { kind: "config"; section: string; values: Record<string, unknown>; raw?: unknown }
  | { kind: "moduleConfig"; section: string; values: Record<string, unknown>; raw?: unknown }
  | { kind: "channel"; index: number; role: number; name: string; hasPsk: boolean; psk: string; uplink: boolean; downlink: boolean; positionPrecision: number; raw?: unknown }
  | { kind: "nodeInfo"; num: number; longName?: string; shortName?: string; hwModel?: string; role?: string; lastHeard: number }
  | { kind: "configComplete"; id: number }
  | { kind: "adminResponse"; sessionPasskey: Uint8Array }
  | { kind: "other"; case: string };

/**
 * Device-config fields that are credentials, in every casing the protobuf and our own projections
 * use. They are replaced with a `has_*` boolean, never a value.
 *
 * The station-node config snapshot is returned to the browser by /api/v1/admin/node/config and
 * rendered by the TX manager, so `moduleConfig.mqtt.password` was printed into the DOM as plaintext
 * and `config.network.wifi_psk` was shipped in the JSON. The channel PSK on the very same code path
 * was already gated behind an explicit includePsk flag for exactly this reason. Nothing needs these
 * values back: a config write is a read-modify-write on the section the node itself reported, so an
 * unchanged credential is preserved on the device without ever leaving it.
 */
const REDACTED_CONFIG_KEYS = new Set(["password", "wifiPsk", "wifi_psk"]);

/**
 * Project a config/module-config section into snake_case values, using the protobuf schema's own
 * field metadata rather than guessing.
 *
 * The generic fallback used to be `shallowScalars`, which copied protobuf-es camelCase keys and left
 * enums as raw numbers, dropping nested and repeated fields entirely. That made 8 of 10 Config arms
 * and 16 of 17 ModuleConfig arms present-but-unreadable: `positionBroadcastSecs` where every consumer
 * looks for `position_broadcast_secs`, `gpsMode: 1` where the editor wants "ENABLED", and no
 * `ignore_incoming` at all. It is also what made the position section actively destructive before it
 * was mapped by hand.
 *
 * Doing it from the schema covers every arm at once and stays correct as the protobuf package moves:
 *   * field names come from the descriptor (`f.name` is already snake_case on the wire),
 *   * enum values resolve to their upstream NAME,
 *   * repeated scalars are kept as arrays,
 *   * nested messages recurse one level, so a section's sub-message is visible rather than dropped,
 *   * credentials are redacted (see REDACTED_CONFIG_KEYS).
 */
function sectionValues(schema: any, obj: any, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj || typeof obj !== "object") return out;
  for (const f of schema?.fields ?? []) {
    const v = obj[f.localName];
    if (v === null || v === undefined) continue;
    const key: string = f.name ?? camelToSnake(f.localName);
    if (REDACTED_CONFIG_KEYS.has(f.localName) || REDACTED_CONFIG_KEYS.has(key)) {
      out[`has_${key}`] = typeof v === "string" ? v !== "" : Boolean(v);
      continue;
    }
    if (f.fieldKind === "enum") {
      out[key] = enumValueName(f.enum, Number(v)) ?? Number(v);
    } else if (f.fieldKind === "list") {
      out[key] = Array.isArray(v)
        ? v.map((x) => (f.listKind === "enum" ? enumValueName(f.enum, Number(x)) ?? Number(x) : normScalar(x)))
        : [];
    } else if (f.fieldKind === "message") {
      // One level only: deeper nesting has no consumer, and unbounded recursion on a
      // self-referential descriptor would not terminate.
      if (depth < 1) out[key] = sectionValues(f.message, v, depth + 1);
    } else {
      out[key] = normScalar(v);
    }
  }
  return out;
}

/** protobuf-es exposes enum values keyed by number on the descriptor. */
function enumValueName(desc: any, n: number): string | undefined {
  const v = desc?.values?.[n] ?? desc?.value?.[n];
  return v?.name ?? undefined;
}

function normScalar(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  return v;
}

function shallowScalars(obj: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (REDACTED_CONFIG_KEYS.has(k)) {
      if (typeof v === "string") out[`has_${k === "wifiPsk" ? "wifi_psk" : k}`] = v !== "";
      continue;
    }
    const t = typeof v;
    if (t === "number" || t === "string" || t === "boolean" || t === "bigint") out[k] = t === "bigint" ? Number(v) : v;
  }
  return out;
}

function normConfigSection(m: any, cfg: any): FromRadioMsg {
  const cv = cfg?.payloadVariant;
  if (!cv?.case) return { kind: "config", section: "unknown", values: {} };
  const v = cv.value ?? {};
  if (cv.case === "lora") {
    return { kind: "config", section: "lora", raw: v, values: {
      region: enumName(m?.Config?.Config_LoRaConfig_RegionCode, v.region) ?? v.region,
      modem_preset: enumName(m?.Config?.Config_LoRaConfig_ModemPreset, v.modemPreset) ?? v.modemPreset,
      use_preset: !!v.usePreset, hop_limit: Number(v.hopLimit ?? 0), tx_enabled: v.txEnabled !== false,
      tx_power: Number(v.txPower ?? 0), channel_num: Number(v.channelNum ?? 0), sx126x_rx_boosted_gain: !!v.sx126xRxBoostedGain,
      config_ok_to_mqtt: !!v.configOkToMqtt, ignore_mqtt: !!v.ignoreMqtt,
    } };
  }
  if (cv.case === "device") {
    return { kind: "config", section: "device", raw: v, values: {
      role: enumName(m?.Config?.Config_DeviceConfig_Role, v.role) ?? v.role,
      rebroadcast_mode: enumName(m?.Config?.Config_DeviceConfig_RebroadcastMode, v.rebroadcastMode) ?? v.rebroadcastMode,
      node_info_broadcast_secs: Number(v.nodeInfoBroadcastSecs ?? 0),
    } };
  }
  if (cv.case === "position") {
    // Mapped explicitly, like lora/device/mqtt. Falling through to shallowScalars left the keys in
    // protobuf-es camelCase, which neither the editor nor the write path reads: the Position panel
    // showed blank/false on a healthy node, and because the firmware replaces the section wholesale
    // AND clears the stored position when gps_mode leaves ENABLED (AdminModule.cpp), a single
    // position edit switched the node's GPS off and erased its position.
    return { kind: "config", section: "position", raw: v, values: {
      position_broadcast_secs: Number(v.positionBroadcastSecs ?? 0),
      position_broadcast_smart_enabled: !!v.positionBroadcastSmartEnabled,
      fixed_position: !!v.fixedPosition,
      gps_update_interval: Number(v.gpsUpdateInterval ?? 0),
      gps_mode: enumName(m?.Config?.Config_PositionConfig_GpsMode, v.gpsMode) ?? v.gpsMode,
      position_flags: Number(v.positionFlags ?? 0),
      broadcast_smart_minimum_distance: Number(v.broadcastSmartMinimumDistance ?? 0),
      broadcast_smart_minimum_interval_secs: Number(v.broadcastSmartMinimumIntervalSecs ?? 0),
      gps_en_gpio: Number(v.gpsEnGpio ?? 0),
      rx_gpio: Number(v.rxGpio ?? 0),
      tx_gpio: Number(v.txGpio ?? 0),
    } };
  }
  // Every other arm: projected from the schema, so it is readable and enum-resolved like the four
  // above rather than a bag of camelCase keys and raw enum numbers.
  return { kind: "config", section: cv.case, values: sectionValues(configArmSchema(m, cv.case), v), raw: v };
}

/** The message schema behind one Config oneof arm, e.g. "lora" -> Config_LoRaConfigSchema. */
function configArmSchema(m: any, arm: string): any {
  return armSchemaFromOneof(m?.Config?.ConfigSchema, arm);
}

/** The message schema behind one ModuleConfig oneof arm. */
function moduleArmSchema(m: any, arm: string): any {
  return armSchemaFromOneof(m?.ModuleConfig?.ModuleConfigSchema, arm);
}

/** Find a oneof member's message descriptor by its arm name. */
function armSchemaFromOneof(schema: any, arm: string): any {
  for (const f of schema?.fields ?? []) {
    if (f.localName === arm || f.name === arm) return f.message;
    for (const inner of f?.fields ?? []) if (inner.localName === arm || inner.name === arm) return inner.message;
  }
  return undefined;
}

/**
 * Normalize a ModuleConfig section. protobuf-es hands us camelCase keys; the editor and write
 * path speak snake_case, so mqtt is mapped explicitly (raw shallowScalars would leave camelCase
 * keys the editor can't read, silently showing every mqtt toggle as off).
 */
function normModuleSection(mc: any, m: any): FromRadioMsg {
  const cv = mc?.payloadVariant;
  if (!cv?.case) return { kind: "moduleConfig", section: "unknown", values: {} };
  const v = cv.value ?? {};
  if (cv.case === "mqtt") {
    return { kind: "moduleConfig", section: "mqtt", raw: v, values: {
      enabled: !!v.enabled, address: String(v.address ?? ""), username: String(v.username ?? ""),
      // Never the value: this snapshot is returned to the browser. See REDACTED_CONFIG_KEYS.
      has_password: String(v.password ?? "") !== "", root: String(v.root ?? ""),
      encryption_enabled: !!v.encryptionEnabled, json_enabled: !!v.jsonEnabled,
      tls_enabled: !!v.tlsEnabled, proxy_to_client_enabled: !!v.proxyToClientEnabled,
      map_reporting_enabled: !!v.mapReportingEnabled,
    } };
  }
  return { kind: "moduleConfig", section: cv.case, values: sectionValues(moduleArmSchema(m, cv.case), v), raw: v };
}

/** Decode one FromRadio frame into a normalized message, or null on undecodable bytes. */
export async function decodeFromRadio(bytes: Uint8Array): Promise<FromRadioMsg | null> {
  const m = await pb();
  let fr: any;
  try {
    fr = decodeBin(m.Mesh.FromRadioSchema, bytes);
  } catch {
    return null;
  }
  const v = fr?.payloadVariant;
  if (!v?.case) return null;
  try {
    switch (v.case) {
      case "myInfo":
        return { kind: "myInfo", myNodeNum: Number(v.value.myNodeNum ?? 0) >>> 0 };
      case "metadata": {
        const d = v.value ?? {};
        return { kind: "metadata", firmwareVersion: String(d.firmwareVersion ?? ""),
          hwModel: enumName(m?.Mesh?.HardwareModel, d.hwModel), role: enumName(m?.Config?.Config_DeviceConfig_Role, d.role),
          hasWifi: !!d.hasWifi, hasBluetooth: !!d.hasBluetooth };
      }
      case "config":
        return normConfigSection(m, v.value);
      case "moduleConfig":
        return normModuleSection(v.value, m);
      case "channel": {
        const c = v.value ?? {}; const s = c.settings ?? {};
        const psk: Uint8Array | undefined = s.psk && s.psk.length ? s.psk : undefined;
        return { kind: "channel", raw: c, index: Number(c.index ?? 0), role: Number(c.role ?? 0),
          name: String(s.name ?? ""), hasPsk: !!psk, psk: psk ? Buffer.from(psk).toString("base64") : "",
          uplink: !!s.uplinkEnabled, downlink: !!s.downlinkEnabled, positionPrecision: Number(s.moduleSettings?.positionPrecision ?? 0) };
      }
      case "nodeInfo": {
        const n = v.value ?? {}; const u = n.user ?? {};
        return { kind: "nodeInfo", num: Number(n.num ?? 0) >>> 0, longName: u.longName ?? undefined, shortName: u.shortName ?? undefined,
          hwModel: enumName(m?.Mesh?.HardwareModel, u.hwModel), role: enumName(m?.Config?.Config_DeviceConfig_Role, u.role), lastHeard: Number(n.lastHeard ?? 0) };
      }
      case "configCompleteId":
        return { kind: "configComplete", id: Number(v.value ?? 0) >>> 0 };
      case "packet": {
        // An admin reply from the node (e.g. a get_*_response) carries the session_passkey the
        // firmware requires on subsequent set_* writes. Pull it out of the decoded ADMIN_APP payload.
        const pkt = v.value ?? {};
        const dv = pkt.payloadVariant;
        if (dv?.case === "decoded" && Number(dv.value?.portnum) === 6 && dv.value?.payload?.length) {
          const admin = decodeBin(m.Admin.AdminMessageSchema, dv.value.payload);
          if (admin?.sessionPasskey?.length) return { kind: "adminResponse", sessionPasskey: admin.sessionPasskey };
        }
        return { kind: "other", case: "packet" };
      }
      default:
        return { kind: "other", case: String(v.case) };
    }
  } catch {
    return { kind: "other", case: String(v.case) };
  }
}
