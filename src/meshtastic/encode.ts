// ServiceEnvelope encode for the TX pipeline. This is the inverse of decode.ts and, like
// it, is the ONLY TX file that touches the protobuf library (@meshtastic/protobufs via
// protobuf-es v2, accessed dynamically and `any`-typed). Everything upstream builds a
// TxRequest; this turns it into signed-for-the-channel ServiceEnvelope bytes + a topic.
import { create, toBinary } from "@bufbuild/protobuf";
import { randomBytes } from "node:crypto";
import { expandKey, encryptPayload, channelHash } from "./crypto.ts";
import { formatNodeId } from "./types.ts";
import { frame as frameStream } from "../node/frame.ts";

const BROADCAST = 0xffffffff;
const PORT_TEXT = 1;
const PORT_POSITION = 3;
const PORT_NODEINFO = 4;
const PORT_ADMIN = 6;
const PORT_TELEMETRY = 67;
const PORT_TRACEROUTE = 70;

let pbMod: unknown = null;
async function pb(): Promise<any> {
  if (!pbMod) pbMod = await import("@meshtastic/protobufs");
  return pbMod;
}

export type TxKind = "text" | "dm" | "traceroute" | "position_req" | "telemetry_req" | "announce" | "admin_probe";

export interface TxRequest {
  kind: TxKind;
  fromNode: number; // our virtual node id (tx.from_node)
  toNode?: number | null; // dm / request / traceroute target; broadcast for channel text
  channelIndex: number; // MeshPacket.channel index
  channelName: string; // ServiceEnvelope.channel_id + topic segment
  channelKey: string; // base64 PSK; empty/0x00 = unencrypted channel
  text?: string; // text / dm body
  longName?: string; // announce (NODEINFO) long name
  shortName?: string; // announce (NODEINFO) short name
  hopLimit: number;
  /** MeshPacket.hop_start. Defaults to hopLimit (a fresh origination). The patcher's faithful
   * uplink sets it separately so a relayed message is not republished as a 0-hop direct. */
  hopStart?: number;
  wantAck: boolean;
  // Sets Data.bitfield bit 0 (OK-to-MQTT) so gateways/bridges will uplink our traffic.
  // Undefined is treated as true (a fresh install wants its own sends visible on MQTT).
  okToMqtt?: boolean;
  /**
   * MQTT topic root the gateway subscribes under, e.g. "msh" (the firmware default) or a
   * community root like "msh/US/IN/NWI". Comes from the broker's root_topic via
   * effectiveTopicRoot -- NOT a region code. The firmware builds `<root>/2/e/<channel>/<node>`
   * and subscribes to `<root>/2/e/<channel>/+`, and MQTT "+" matches exactly one level, so an
   * extra path segment here means no gateway ever receives the packet.
   */
  topicRoot: string;
  packetId?: number; // optional (tests pin it); otherwise random non-zero u32
  // ServiceEnvelope gateway id + topic segment. Defaults to fromNode (HopWatch as itself).
  // Set distinctly for a faithful RF->MQTT uplink: from = original RF sender, gateway = our node.
  gatewayNode?: number;
}

export interface EncodedTx {
  packetId: number;
  bytes: Uint8Array; // serialized ServiceEnvelope for MQTT publish
  topic: string; // downlink topic
}

/** Random non-zero u32 packet id, the way the firmware assigns them. */
export function randomPacketId(): number {
  let id = 0;
  while (id === 0) id = randomBytes(4).readUInt32LE(0) >>> 0;
  return id;
}

function portAndPayload(m: any, req: TxRequest): { portnum: number; payload: Uint8Array; wantResponse: boolean } {
  switch (req.kind) {
    case "text":
    case "dm":
      return { portnum: PORT_TEXT, payload: new TextEncoder().encode(req.text ?? ""), wantResponse: false };
    case "traceroute":
      return {
        portnum: PORT_TRACEROUTE,
        payload: toBinary(m.Mesh.RouteDiscoverySchema, create(m.Mesh.RouteDiscoverySchema, {})),
        wantResponse: true,
      };
    case "position_req":
      return { portnum: PORT_POSITION, payload: new Uint8Array(), wantResponse: true };
    case "telemetry_req": {
      // A ZERO-LENGTH Telemetry decodes with which_variant == 0, and every port-67 module's
      // allocReply returns NULL for that, so an empty payload is a request no firmware can answer.
      // Ask for device metrics explicitly: the variant tells the target which reply to build.
      const t = create(m.Telemetry.TelemetrySchema, {
        variant: { case: "deviceMetrics", value: create(m.Telemetry.DeviceMetricsSchema, {}) },
      });
      return { portnum: PORT_TELEMETRY, payload: toBinary(m.Telemetry.TelemetrySchema, t), wantResponse: true };
    }
    case "announce": {
      const user = create(m.Mesh.UserSchema, {
        id: formatNodeId(req.fromNode),
        longName: req.longName ?? "HopWatch",
        shortName: req.shortName ?? "HOPW",
      });
      return { portnum: PORT_NODEINFO, payload: toBinary(m.Mesh.UserSchema, user), wantResponse: false };
    }
    case "admin_probe": {
      // Remote-admin discovery: a get_device_metadata_request to the target. Sent DECODED through
      // the station node (node transport), which PKI-encrypts it as an authorized admin -- HopWatch
      // cannot construct the PKI itself. A response means the node is administrable.
      const admin = create(m.Admin.AdminMessageSchema, { payloadVariant: { case: "getDeviceMetadataRequest", value: true } });
      return { portnum: PORT_ADMIN, payload: toBinary(m.Admin.AdminMessageSchema, admin), wantResponse: true };
    }
  }
}

// Build the MeshPacket (channel-encrypting the payload when a PSK is present). Shared by
// both the MQTT (ServiceEnvelope) and node (ToRadio) encoders so they stay identical.
function buildPacket(m: any, req: TxRequest): { packetId: number; packet: unknown } {
  const packetId = (req.packetId ?? randomPacketId()) >>> 0;
  const to = ((req.kind === "text" ? (req.toNode ?? BROADCAST) : req.toNode) ?? BROADCAST) >>> 0;
  const { portnum, payload, wantResponse } = portAndPayload(m, req);
  // Data.bitfield (field 9) bit 0 = OK-to-MQTT: the sender's approval for gateways to uplink
  // this packet. It lives on Data, INSIDE the encrypted payload, not on MeshPacket -- so a
  // receiver can only read it after decrypting. Default true when unspecified.
  const bitfield = (req.okToMqtt ?? true) ? 1 : 0;
  const data = create(m.Mesh.DataSchema, { portnum, payload, wantResponse, bitfield });
  const dataBytes = toBinary(m.Mesh.DataSchema, data);
  const key = expandKey(req.channelKey);
  const encrypted = key ? new Uint8Array(encryptPayload(dataBytes, key, packetId, req.fromNode)) : null;
  // MeshPacket.channel is overloaded by transport. On an ENCRYPTED packet the receiver reads it
  // as the 8-bit channel HASH (Router::perhapsDecode -> Channels::decryptForHash); sending the
  // index there means no node can match a channel and the packet is dropped undecrypted. On a
  // DECODED packet (the ToRadio/node path) the station node encrypts for us and wants the index.
  const channel = encrypted ? channelHash(req.channelName, key) : req.channelIndex;
  const packet = create(m.Mesh.MeshPacketSchema, {
    from: req.fromNode >>> 0,
    to,
    id: packetId,
    channel,
    hopLimit: req.hopLimit,
    hopStart: req.hopStart ?? req.hopLimit,
    wantAck: req.wantAck,
    payloadVariant: encrypted ? { case: "encrypted", value: encrypted } : { case: "decoded", value: data },
  });
  return { packetId, packet };
}

/**
 * Build (and channel-encrypt) a ServiceEnvelope for one outbound packet. The payload is
 * encrypted with the channel PSK using the same nonce as decode, so it round-trips through
 * decodeProtobufEnvelope with the same key. Returns the bytes + downlink topic to publish.
 */
export async function encodeTx(req: TxRequest): Promise<EncodedTx> {
  const m = await pb();
  const { packetId, packet } = buildPacket(m, req);
  const gateway = formatNodeId((req.gatewayNode ?? req.fromNode) >>> 0);
  const env = create(m.Mqtt.ServiceEnvelopeSchema, { packet, channelId: req.channelName, gatewayId: gateway });
  const bytes = toBinary(m.Mqtt.ServiceEnvelopeSchema, env);
  const root = req.topicRoot.replace(/\/+$/, "");
  if (!root) throw new Error("no MQTT topic root for TX (set the broker's root topic)");
  const topic = `${root}/2/e/${req.channelName}/${gateway}`;
  return { packetId, bytes, topic };
}

/**
 * Framed ToRadio{want_config_id} that asks a station node to dump its full config over the
 * stream API: MyNodeInfo, DeviceMetadata, Config/ModuleConfig sections, Channels, and the
 * NodeDB, terminated by a FromRadio.config_complete_id echoing this nonce.
 */
export async function encodeWantConfig(nonce: number): Promise<Uint8Array> {
  const m = await pb();
  const toRadio = create(m.Mesh.ToRadioSchema, { payloadVariant: { case: "wantConfigId", value: nonce >>> 0 } });
  return frameStream(toBinary(m.Mesh.ToRadioSchema, toRadio));
}

/**
 * Build a framed ToRadio{heartbeat} for the station-node stream.
 *
 * This is a keepalive, NOT a transmission: the firmware answers it with a queue_status FromRadio
 * and touches nothing on the air, so it does not belong in tx_outbox (Rule 2). It exists because
 * ServerAPI.cpp closes the TCP session after TCP_IDLE_TIMEOUT_MS (15 minutes) of client silence,
 * and `lastContactMsec` is refreshed only by PhoneAPI::handleToRadio, i.e. by client-to-node
 * traffic. A receive-only stream therefore gets dropped every 15 minutes no matter how busy the
 * mesh is.
 *
 * The nonce MUST NOT be 1. PhoneAPI.cpp treats heartbeat nonce 1 as a "nodeinfo ping" and calls
 * nodeInfoModule->sendOurNodeInfo(NODENUM_BROADCAST, ...), which is a real RF broadcast outside the
 * outbox and its safety rails. Nonce 0 is the plain keepalive.
 */
export async function encodeHeartbeat(): Promise<Uint8Array> {
  const m = await pb();
  const beat = create(m.Mesh.HeartbeatSchema, { nonce: 0 });
  const toRadio = create(m.Mesh.ToRadioSchema, { payloadVariant: { case: "heartbeat", value: beat } });
  return frameStream(toBinary(m.Mesh.ToRadioSchema, toRadio));
}

/**
 * Build a framed ToRadio for the station-node TCP transport. Unlike the MQTT path, the packet is
 * sent DECODED (plaintext): the node encrypts it with the channel at `channelIndex` and does the
 * RF send, exactly as the phone app does. Pre-encrypting here (as the MQTT ServiceEnvelope path
 * must) would send a packet whose channel hash does not match any real channel, so receivers
 * could never decrypt it. The channel key is therefore cleared before building the packet.
 */
export async function encodeToRadio(req: TxRequest): Promise<{ packetId: number; frame: Uint8Array }> {
  const m = await pb();
  const { packetId, packet } = buildPacket(m, { ...req, channelKey: "" });
  const toRadio = create(m.Mesh.ToRadioSchema, { payloadVariant: { case: "packet", value: packet } });
  const bytes = toBinary(m.Mesh.ToRadioSchema, toRadio);
  return { packetId, frame: frameStream(bytes) };
}
