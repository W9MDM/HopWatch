// Meshtastic channel-payload decryption (AES-CTR). Pure node:crypto, testable.
//
// Key handling matches the firmware:
//   * A 1-byte PSK of 0x00 means "no encryption".
//   * A 1-byte PSK of 0x01 means the well-known default key.
//   * A 1-byte PSK > 0x01 means the default key with its last byte replaced by that byte.
//   * A 16- or 32-byte PSK is used verbatim (AES-128 / AES-256).
//
// Nonce (16 bytes): packetId as u64 LE (8) || fromNode as u32 LE (4) || 0x00000000 (4).
import { createCipheriv, createDecipheriv } from "node:crypto";

// Well-known default channel key (PSK index 1). Equivalent to the canonical
// base64 form "1PG7OiApB1nwvP+rz05pAQ==" used by the meshtastic tooling.
const DEFAULT_KEY = Buffer.from("d4f1bb3a20290759f0bcffabcf4e6901", "hex");

export function expandKey(base64Key: string): Buffer | null {
  const raw = Buffer.from(base64Key, "base64");
  if (raw.length === 0) return null;
  if (raw.length === 1) {
    const idx = raw[0]!;
    if (idx === 0x00) return null; // no encryption
    const key = Buffer.from(DEFAULT_KEY);
    if (idx !== 0x01) key[key.length - 1] = idx;
    return key;
  }
  if (raw.length === 16 || raw.length === 32) return raw;
  // Non-standard length: pad/truncate to 16 (defensive; real keys are 16/32).
  const key = Buffer.alloc(raw.length < 16 ? 16 : 32);
  raw.copy(key);
  return key;
}

/**
 * The 8-bit channel hash a receiver uses to pick which channel to try, per the firmware's
 * Channels::generateHash (Channels.cpp): `xorHash(name) ^ xorHash(expandedPsk)`, where xorHash is
 * a plain XOR fold over the bytes.
 *
 * This is what MeshPacket.channel carries on an ENCRYPTED packet (not the channel index):
 * Router::perhapsDecode loops every configured channel calling
 * `channels.decryptForHash(chIndex, p->channel)`, which compares `getHash(chIndex)` against
 * that value. A packet whose `channel` holds an index instead of this hash matches no channel
 * and is dropped undecrypted by every receiving node.
 *
 * A null key means a zero-length PSK, i.e. an UNENCRYPTED channel. Such a channel still has a
 * hash and still goes out as the encrypted payload variant carrying plaintext: Channels.cpp sets
 * `k.length = 0` for PSK index 0, `generateHash` then xor-folds zero key bytes (so the hash is
 * `xorHash(name)` alone), CryptoEngine::encryptPacket is a no-op under `if (key.length > 0)`, and
 * Router::perhapsEncode still assigns `p->channel = hash` and the encrypted_tag variant. So this
 * returns a number for every usable channel; only a DISABLED channel has no hash upstream.
 */
export function channelHash(name: string, expandedKey: Buffer | null): number {
  const xorFold = (b: Buffer): number => b.reduce((acc, byte) => acc ^ byte, 0);
  const nameHash = xorFold(Buffer.from(name, "utf8"));
  return (expandedKey ? nameHash ^ xorFold(expandedKey) : nameHash) & 0xff;
}

function nonce(packetId: number, fromNode: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(packetId >>> 0, 0); // low 32 of packetId
  buf.writeUInt32LE(0, 4); // high 32 (packet ids are u32)
  buf.writeUInt32LE(fromNode >>> 0, 8);
  buf.writeUInt32LE(0, 12);
  return buf;
}

/**
 * Attempt to decrypt an encrypted Meshtastic payload with a single expanded key.
 * Returns the plaintext Data-protobuf bytes (caller decodes them), or null on error.
 * Note: AES-CTR never "fails" cryptographically; validity is judged by whether the
 * result decodes as a Data protobuf downstream.
 */
export function decryptPayload(
  encrypted: Uint8Array,
  expandedKey: Buffer,
  packetId: number,
  fromNode: number,
): Buffer | null {
  try {
    const algo = expandedKey.length === 32 ? "aes-256-ctr" : "aes-128-ctr";
    const decipher = createDecipheriv(algo, expandedKey, nonce(packetId, fromNode));
    return Buffer.concat([decipher.update(Buffer.from(encrypted)), decipher.final()]);
  } catch {
    return null;
  }
}

/**
 * Encrypt a plaintext Data-protobuf payload for TX. AES-CTR is symmetric, so this uses the
 * identical key/nonce construction as decryptPayload: a packet encrypted here decrypts back
 * with the same (packetId, fromNode). Used by the TX encoder.
 */
export function encryptPayload(
  plain: Uint8Array,
  expandedKey: Buffer,
  packetId: number,
  fromNode: number,
): Buffer {
  const algo = expandedKey.length === 32 ? "aes-256-ctr" : "aes-128-ctr";
  const cipher = createCipheriv(algo, expandedKey, nonce(packetId, fromNode));
  return Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
}
