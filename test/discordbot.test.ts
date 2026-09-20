import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyDiscordSignature } from "../src/lib/discordverify.ts";
import { BOT_COMMANDS } from "../src/lib/discordbot.ts";

// A raw 32-byte Ed25519 public key as hex, the way Discord exposes it (General Information -> Public Key).
function rawPublicKeyHex(pub: import("node:crypto").KeyObject): string {
  const der = pub.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(der.length - 32).toString("hex"); // last 32 bytes of SPKI = the raw key
}

test("valid Ed25519 signature over timestamp+body verifies", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubHex = rawPublicKeyHex(publicKey);
  const ts = "1700000000";
  const body = JSON.stringify({ type: 1 });
  const sig = sign(null, Buffer.from(ts + body, "utf8"), privateKey).toString("hex");
  assert.equal(verifyDiscordSignature(pubHex, sig, ts, body), true);
});

test("a tampered body fails verification", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubHex = rawPublicKeyHex(publicKey);
  const ts = "1700000000";
  const sig = sign(null, Buffer.from(ts + "{}", "utf8"), privateKey).toString("hex");
  assert.equal(verifyDiscordSignature(pubHex, sig, ts, '{"type":2}'), false);
});

test("malformed inputs return false, never throw", () => {
  assert.equal(verifyDiscordSignature("", "aa", "1", "{}"), false);
  assert.equal(verifyDiscordSignature("zz", "aa", "1", "{}"), false); // bad hex
  assert.equal(verifyDiscordSignature("ab".repeat(10), "aa", "1", "{}"), false); // wrong key length
});

test("bot command specs are well-formed for Discord registration", () => {
  const names = new Set<string>();
  for (const c of BOT_COMMANDS) {
    assert.ok(/^[a-z]{1,32}$/.test(c.name), `command name ${c.name} is a valid slash-command name`);
    assert.ok(c.description.length > 0 && c.description.length <= 100, `${c.name} description within 100 chars`);
    assert.ok(!names.has(c.name), `command ${c.name} is unique`);
    names.add(c.name);
    for (const o of (c as { options?: { name: string; type: number }[] }).options ?? []) {
      assert.equal(o.type, 3, `option ${o.name} is a STRING option`);
    }
  }
  assert.ok(names.has("reach") && names.has("myreach"), "core commands present");
});
