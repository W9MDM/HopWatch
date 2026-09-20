import { createPublicKey, verify } from "node:crypto";

// Every Discord interaction request is signed with the application's Ed25519 key. The endpoint MUST
// reject anything that fails verification (Discord validates this by sending a deliberately-bad
// signature when you save the Interactions Endpoint URL, and expects a 401). We verify with Node's
// built-in crypto, no external dependency: a raw 32-byte Ed25519 public key is wrapped in the fixed
// SPKI DER prefix so createPublicKey accepts it, then the signature covers `timestamp + rawBody`.

// SPKI DER header for an Ed25519 public key (RFC 8410): SEQUENCE { AlgId { 1.3.101.112 }, BIT STRING }.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** True only if `signatureHex` is a valid Ed25519 signature over (timestamp + rawBody) for
 * `publicKeyHex`. Any malformed input (bad hex, wrong key length, bad signature) returns false
 * rather than throwing, so the caller can answer a clean 401. */
export function verifyDiscordSignature(publicKeyHex: string, signatureHex: string, timestamp: string, rawBody: string): boolean {
  try {
    if (!publicKeyHex || !signatureHex || !timestamp) return false;
    const raw = Buffer.from(publicKeyHex, "hex");
    if (raw.length !== 32) return false; // an Ed25519 public key is exactly 32 bytes (64 hex chars)
    const sig = Buffer.from(signatureHex, "hex");
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(timestamp + rawBody, "utf8"), key, sig);
  } catch {
    return false;
  }
}
