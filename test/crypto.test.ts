import { test } from "node:test";
import assert from "node:assert/strict";
import { expandKey, decryptPayload } from "../src/meshtastic/crypto.ts";

const DEFAULT_KEY_HEX = "d4f1bb3a20290759f0bcffabcf4e6901";

test("AQ== (0x01) expands to the well-known default key", () => {
  const key = expandKey("AQ==");
  assert.ok(key);
  assert.equal(key!.toString("hex"), DEFAULT_KEY_HEX);
  assert.equal(key!.length, 16);
});

test("AA== (0x00) means no encryption -> null", () => {
  assert.equal(expandKey("AA=="), null);
});

test("empty key -> null", () => {
  assert.equal(expandKey(""), null);
});

test("single byte > 1 replaces the default key's last byte", () => {
  const key = expandKey(Buffer.from([0x08]).toString("base64"));
  assert.ok(key);
  assert.equal(key!.subarray(0, 15).toString("hex"), DEFAULT_KEY_HEX.slice(0, 30));
  assert.equal(key![15], 0x08);
});

test("16-byte key is used verbatim (AES-128)", () => {
  const raw = Buffer.alloc(16, 0x2a);
  const key = expandKey(raw.toString("base64"));
  assert.equal(key!.toString("hex"), raw.toString("hex"));
});

test("32-byte key is used verbatim (AES-256)", () => {
  const raw = Buffer.alloc(32, 0x2a);
  const key = expandKey(raw.toString("base64"));
  assert.equal(key!.length, 32);
});

test("AES-CTR round-trips: encrypt-then-decrypt with same key/nonce", () => {
  // CTR is symmetric, so decrypting ciphertext produced by the same op returns plaintext.
  const key = expandKey("AQ==")!;
  const plaintext = Buffer.from("hello mesh", "utf8");
  const cipher = decryptPayload(plaintext, key, 0x1234, 0xabcd)!; // "encrypt"
  const back = decryptPayload(cipher, key, 0x1234, 0xabcd)!; // "decrypt"
  assert.equal(back.toString("utf8"), "hello mesh");
});

test("wrong nonce (different packet id) does not recover plaintext", () => {
  const key = expandKey("AQ==")!;
  const plaintext = Buffer.from("hello mesh", "utf8");
  const cipher = decryptPayload(plaintext, key, 0x1234, 0xabcd)!;
  const back = decryptPayload(cipher, key, 0x9999, 0xabcd)!;
  assert.notEqual(back.toString("utf8"), "hello mesh");
});
