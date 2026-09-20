// Normalized shapes the ingest pipeline works with, decoupled from protobuf types.
// decode.ts converts raw ServiceEnvelope bytes into these; classify.ts and the
// pipeline consume them. This boundary keeps protobuf-library specifics in one file.

export const BROADCAST_ADDR = 0xffffffff;

export interface NormalizedPacket {
  meshPacketId: number;
  from: number;
  to: number | null;
  /**
   * MeshPacket.channel, verbatim. Overloaded on the wire: on an ENCRYPTED-variant packet it is the
   * 8-bit channel HASH (`xorHash(name) ^ xorHash(psk)`), and on a DECODED one it is the publisher's
   * local channel INDEX, because Router::perhapsDecode rewrites it after decrypting
   * (`p->channel = chIndex; // change to store the index instead of the hash`).
   */
  channel: number | null;
  /** True when `channel` holds the hash rather than an index, i.e. the payload arrived encrypted.
   * Without this the two encodings were stored in one column named `channel_index`, so two
   * receptions of the same packet disagreed and the UI rendered a hash byte as a channel number. */
  channelIsHash: boolean;
  hopStart: number | null;
  hopLimit: number | null;
  relayNode: number | null;
  rxRssi: number | null;
  rxSnr: number | null;
  /** Gateway-reported receive time (epoch ms UTC), or null if absent. */
  rxTimeMs: number | null;
  wantAck: boolean;
  viaMqtt: boolean;
  /**
   * Sender approved MQTT upload (Data.bitfield bit 0). Gates the MQTT bridge. The bit lives on
   * the inner Data, i.e. inside the encrypted payload, so it is only knowable once the packet
   * is decrypted; an undecryptable packet reports false (fail closed).
   */
  okToMqtt: boolean;
  /** Present when the packet arrived encrypted and could not be decoded. */
  encrypted: Uint8Array | null;
  /**
   * The raw encrypted-variant bytes, retained whether or not a key opened them. Key selection can
   * be wrong (a channel-hash collision, or a fallback guess when no configured key matched the
   * hash) and the packets upsert pins decode_status='decoded' permanently, so discarding the
   * ciphertext on an apparent decode made a false accept unrecoverable: there is no re-decode job
   * that could revisit it. Null for the decoded payload variant, which never carried ciphertext.
   */
  cipherText: Uint8Array | null;
  /**
   * MeshPacket.pki_encrypted (field 17): the payload is Curve25519 + AES-CCM, not channel-PSK
   * AES-CTR, so no channel key can ever open it. Set by the gateway both when it decrypted the DM
   * itself and, per Router.cpp, when it could not (an undecodable DM with channel 0). Gateways also
   * label these uplinks ServiceEnvelope.channel_id = "PKI".
   */
  pkiEncrypted: boolean;
  /** MeshPacket.public_key (field 16): the sender's 32-byte Curve25519 key, present only when the
   * gateway itself decrypted a PKI packet. */
  publicKey: Uint8Array | null;
  /** Present when the inner Data was decoded. */
  decoded: DecodedData | null;
}

export interface DecodedData {
  portnum: number;
  portName: string;
  payload: Uint8Array;
  /** Data.bitfield (field 9). Bit 0 = sender approved MQTT upload. 0 when absent. */
  bitfield: number;
  /** Best-effort typed decode of the inner payload by port. */
  parsed: ParsedPayload | null;
}

export type ParsedPayload =
  | { kind: "position"; latitude: number; longitude: number; altitudeM: number | null; precisionBits: number | null }
  | { kind: "nodeinfo"; longName?: string; shortName?: string; hwModel?: string; role?: string; publicKey?: Uint8Array; isLicensed?: boolean }
  | { kind: "telemetry"; metrics: Record<string, number> }
  // replyToPacketId = Data.reply_id (the mesh packet id being replied to); isReaction is set when
  // Data.emoji is non-zero, meaning the body is a tapback reaction rather than a typed message.
  | { kind: "text"; text: string; replyToPacketId?: number; isReaction?: boolean }
  | { kind: "traceroute"; route: number[]; snrTowards: number[]; snrBack: number[]; routeBack: number[] }
  // ROUTING_APP (port 5). `requestId` is Data.request_id, the packet id being answered, which is
  // what makes ack/NAK correlation exact instead of "some port-5 packet came back". Routing.Error
  // NONE (0) is an ACK; any other code is a NAK and is proof of FAILED delivery.
  // DETECTION_SENSOR_APP (10) and ALERT_APP (11). Plain UTF-8 like port 1, and the firmware treats
  // all three as "text message" for delivery, but these are physical-world events and mesh alerts,
  // not chat: kept as their own kind so they do not appear in /messages or reach the text bridge.
  | { kind: "sensor"; sensorKind: "detection" | "alert"; text: string }
  // KEY_VERIFICATION_APP (port 12): the out-of-band PKI verification handshake. `nonce` correlates
  // every message of one exchange; the stage is implied by which hash is present, and the hashes
  // themselves are handshake material, so only their presence is recorded.
  | { kind: "keyverification"; nonce: number; stage: "request" | "response" | "final" }
  | { kind: "routing"; requestId: number; errorCode: number; errorName: string | null; variant: string | null }
  | { kind: "neighborinfo"; node: number; neighbors: { node: number; snr: number }[] }
  // MAP_REPORT_APP (port 73), published to the `/2/map/` topic. A node's self-report of its
  // identity, firmware and deliberately-coarsened position, sent only when the operator opted in
  // to map reporting. Position here is intentionally low precision: never treat it as a GPS fix.
  | {
      kind: "mapreport"; longName?: string; shortName?: string; hwModel?: string; role?: string;
      firmwareVersion?: string; region?: string; modemPreset?: string; hasDefaultChannel?: boolean;
      latitude: number | null; longitude: number | null; altitudeM: number | null;
      precisionBits: number | null; numOnlineLocalNodes: number | null;
    }
  | { kind: "raw"; hex: string };

export interface NormalizedEnvelope {
  gatewayId: number;
  channelId: string;
  packet: NormalizedPacket;
  /** True when the source was a JSON topic rather than protobuf. */
  fromJson: boolean;
}

/** Parse a gateway id which Meshtastic encodes as "!aabbccdd" (hex) or a number. */
export function parseNodeId(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return v >>> 0;
  const s = v.startsWith("!") ? v.slice(1) : v;
  const n = parseInt(s, 16);
  return Number.isNaN(n) ? 0 : n >>> 0;
}

/** Render a node id as the canonical "!aabbccdd" form. */
export function formatNodeId(n: number): string {
  return "!" + (n >>> 0).toString(16).padStart(8, "0");
}
