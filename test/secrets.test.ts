import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HOPWATCH_MASTER_KEY = "test-master-key-for-unit-tests";
const { encryptSecret, decryptSecret, isEncrypted, secretDecryptFailures } = await import("../src/lib/secrets.ts");

test("encrypt then decrypt round-trips", () => {
  const secret = "smtp-p@ssw0rd!";
  const enc = encryptSecret(secret);
  assert.ok(isEncrypted(enc));
  assert.notEqual(enc, secret);
  assert.equal(decryptSecret(enc), secret);
});

test("empty string stays empty (not encrypted)", () => {
  assert.equal(encryptSecret(""), "");
  assert.equal(isEncrypted(""), false);
});

test("plaintext passes through decrypt unchanged (legacy values)", () => {
  assert.equal(decryptSecret("plainvalue"), "plainvalue");
});

test("re-encrypting an already-encrypted value is a no-op", () => {
  const enc = encryptSecret("x");
  assert.equal(encryptSecret(enc), enc);
});

test("each encryption uses a fresh IV (ciphertexts differ)", () => {
  assert.notEqual(encryptSecret("same"), encryptSecret("same"));
});

test("tampered ciphertext reads as unset instead of throwing", () => {
  // Never throw: getChannelKeys / getRuntimeBrokers / effectiveConfig map decryptSecret over every
  // row with no try, and ingest awaits them bare at startup, so a throw here (which is what EVERY
  // stored secret does after a master-key change) exited the daemon into a permanent systemd
  // restart loop. Degrade to "unset" and name the secret in the log instead.
  const enc = encryptSecret("secret");
  const parts = enc.split(":");
  const ct = Buffer.from(parts[4]!, "base64");
  ct[0] = ct[0]! ^ 0xff;
  parts[4] = ct.toString("base64");
  assert.equal(decryptSecret(parts.join(":"), "channel key \"LongFast\""), "");
  assert.ok(secretDecryptFailures().includes('channel key "LongFast"'), "failure is reported by label");
});

test("a malformed envelope reads as unset and is reported", () => {
  assert.equal(decryptSecret("enc:v1:onlyonepart", "broker \"a\" password"), "");
  assert.ok(secretDecryptFailures().includes('broker "a" password'));
});

test("array-valued secret paths round-trip encrypted", async () => {
  // Alert webhook/ntfy targets embed a bearer token in the URL itself, exactly like the forwarding
  // targets this project already encrypts. The SECRET_PATHS walker only acted on strings, so these
  // were written verbatim into app_setting.config_overrides: any DB dump or backup yielded live
  // webhook tokens. This pins the array handling in both directions.
  const url = "https://discord.com/api/webhooks/12345/live-token-value";
  const enc = encryptSecret(url);
  assert.ok(isEncrypted(enc));
  assert.ok(!enc.includes("live-token-value"));
  assert.equal(decryptSecret(enc, "setting alerts.delivery.webhook[0]"), url);
});
