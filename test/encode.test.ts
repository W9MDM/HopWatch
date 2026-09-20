import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeTx, randomPacketId } from "../src/meshtastic/encode.ts";
import { decodeProtobufEnvelope } from "../src/meshtastic/decode.ts";
import { parseTopic } from "../src/meshtastic/topic.ts";
import { expandKey, encryptPayload, decryptPayload, channelHash } from "../src/meshtastic/crypto.ts";

// Default channel PSK (base64 of 0x01 -> the well-known default key).
const KEY = "AQ==";
const KEYS = [{ name: "LongFast", key: KEY }];

async function roundTrip(req: Parameters<typeof encodeTx>[0]) {
  const enc = await encodeTx(req);
  const env = await decodeProtobufEnvelope(enc.bytes, parseTopic(enc.topic), KEYS);
  return { enc, env };
}

test("encrypt/decrypt payload round-trips with the same packet id + from", () => {
  const key = expandKey(KEY)!;
  const plain = Buffer.from("hello mesh");
  const ct = encryptPayload(plain, key, 12345, 0x11223344);
  assert.notDeepEqual(new Uint8Array(ct), new Uint8Array(plain));
  assert.equal(decryptPayload(ct, key, 12345, 0x11223344)!.toString(), "hello mesh");
  // A different nonce (packet id) does not recover the plaintext.
  assert.notEqual(decryptPayload(ct, key, 99999, 0x11223344)!.toString(), "hello mesh");
});

test("encode text -> decode round-trips through our own decoder", async () => {
  const { enc, env } = await roundTrip({
    kind: "text", fromNode: 0xaabbccdd, channelIndex: 0, channelName: "LongFast",
    channelKey: KEY, text: "hello from hopwatch", hopLimit: 3, wantAck: false, topicRoot: "msh", packetId: 0x1234,
  });
  assert.equal(env.packet.meshPacketId, 0x1234);
  assert.equal(env.packet.from, 0xaabbccdd);
  assert.equal(env.packet.to, 0xffffffff, "channel text is broadcast");
  assert.equal(env.packet.hopLimit, 3);
  assert.equal(env.packet.hopStart, 3);
  assert.equal(env.packet.encrypted, null, "should decrypt with the channel key, not retain ciphertext");
  assert.equal(env.packet.decoded?.parsed?.kind, "text");
  assert.equal((env.packet.decoded?.parsed as any).text, "hello from hopwatch");
  assert.equal(enc.topic, "msh/2/e/LongFast/!aabbccdd");
});

test("encode dm addresses the target node and honors want_ack", async () => {
  const { env } = await roundTrip({
    kind: "dm", fromNode: 0x1, toNode: 0x0badf00d, channelIndex: 0, channelName: "LongFast",
    channelKey: KEY, text: "dm body", hopLimit: 3, wantAck: true, topicRoot: "msh",
  });
  assert.equal(env.packet.to, 0x0badf00d);
  assert.equal(env.packet.wantAck, true);
  assert.equal((env.packet.decoded?.parsed as any).text, "dm body");
});

test("encode traceroute is a TRACEROUTE_APP packet to the target", async () => {
  const { env } = await roundTrip({
    kind: "traceroute", fromNode: 0x1, toNode: 0x2, channelIndex: 0, channelName: "LongFast",
    channelKey: KEY, hopLimit: 3, wantAck: false, topicRoot: "msh",
  });
  assert.equal(env.packet.to, 0x2);
  assert.equal(env.packet.decoded?.parsed?.kind, "traceroute");
});

test("without the channel key the payload stays encrypted (undecodable)", async () => {
  const enc = await encodeTx({
    kind: "text", fromNode: 0x1, channelIndex: 0, channelName: "LongFast",
    channelKey: KEY, text: "secret", hopLimit: 3, wantAck: false, topicRoot: "msh",
  });
  const env = await decodeProtobufEnvelope(enc.bytes, parseTopic(enc.topic), []);
  assert.equal(env.packet.decoded, null);
  assert.ok(env.packet.encrypted && env.packet.encrypted.length > 0, "ciphertext retained");
});

test("randomPacketId is a non-zero u32", () => {
  for (let i = 0; i < 100; i++) {
    const id = randomPacketId();
    assert.ok(id > 0 && id <= 0xffffffff);
  }
});

// ---------------------------------------------------------------------------
// OK-to-MQTT (Data.bitfield bit 0). Upstream mesh.proto puts `bitfield` on Data
// (field 9), NOT on MeshPacket -- MeshPacket field 22 is `xeddsa_signed`. These
// tests pin that placement so the bit is never written to the wrong message again.
// ---------------------------------------------------------------------------

test("ok_to_mqtt sets Data.bitfield bit 0 and survives channel encryption", async () => {
  for (const ok of [true, false]) {
    const { env } = await roundTrip({
      kind: "text", fromNode: 0x11223344, channelIndex: 0, channelName: "LongFast",
      channelKey: KEY, text: "hello mesh", hopLimit: 3, wantAck: false, okToMqtt: ok, topicRoot: "msh",
    });
    assert.equal(env.packet.decoded?.bitfield, ok ? 1 : 0);
    assert.equal(env.packet.okToMqtt, ok);
  }
});

test("ok_to_mqtt defaults to true when unspecified", async () => {
  const { env } = await roundTrip({
    kind: "text", fromNode: 0x1, channelIndex: 0, channelName: "LongFast",
    channelKey: KEY, text: "hi", hopLimit: 3, wantAck: false, topicRoot: "msh",
  });
  assert.equal(env.packet.okToMqtt, true);
});

test("encode never sets MeshPacket field 22 (xeddsa_signed) as an unknown field", async () => {
  const enc = await encodeTx({
    kind: "text", fromNode: 0x1, channelIndex: 0, channelName: "LongFast",
    channelKey: KEY, text: "hi", hopLimit: 3, wantAck: false, okToMqtt: true, topicRoot: "msh",
  });
  // Field 22 varint would serialize as tag 0xB0 0x01. Claiming a signature we do not
  // have would misrepresent the packet to any receiver that checks it.
  const wire = Array.from(enc.bytes);
  const hasF22 = wire.some((b, i) => b === 0xb0 && wire[i + 1] === 0x01);
  assert.equal(hasF22, false, "MeshPacket field 22 must not appear on the wire");
});

test("an undecryptable packet reports ok_to_mqtt false (fails the bridge gate closed)", async () => {
  const enc = await encodeTx({
    kind: "text", fromNode: 0x1, channelIndex: 0, channelName: "LongFast",
    channelKey: KEY, text: "secret", hopLimit: 3, wantAck: false, okToMqtt: true, topicRoot: "msh",
  });
  // The bit lives inside the ciphertext, so without the key it is unknowable, not "approved".
  const env = await decodeProtobufEnvelope(enc.bytes, parseTopic(enc.topic), []);
  assert.equal(env.packet.decoded, null);
  assert.equal(env.packet.okToMqtt, false);
});

// ---------------------------------------------------------------------------
// Channel hash + topic root. Both verified against firmware source:
//   Channels.cpp generateHash():  xorHash(name) ^ xorHash(psk), returned as u8
//   Router.cpp perhapsDecode():   channels.decryptForHash(chIndex, p->channel)
//   MQTT.h/MQTT.cpp:              topic = <root> + "/2/e/" + channelId + "/" + nodeId,
//                                 root defaults to bare "msh" (no region segment)
// Getting either wrong makes every MQTT transmit a silent no-op, so pin both.
// ---------------------------------------------------------------------------

test("channelHash matches the firmware xor-fold of name and expanded PSK", () => {
  // "LongFast" + the default PSK, computed the way Channels::generateHash does.
  const key = expandKey(KEY)!;
  const xorFold = (b: Buffer) => b.reduce((a, x) => a ^ x, 0);
  const expected = (xorFold(Buffer.from("LongFast", "utf8")) ^ xorFold(key)) & 0xff;
  assert.equal(channelHash("LongFast", key), expected);
  // A PSK-less (unencrypted) channel still has a hash: Channels::generateHash xor-folds a
  // zero-length key, so the hash is xorHash(name) alone, and Router::perhapsEncode still puts it
  // in MeshPacket.channel. Reporting "no hash" made PSK-less/ham-mode traffic undecodable.
  assert.equal(channelHash("LongFast", null), xorFold(Buffer.from("LongFast", "utf8")));
});

test("an encrypted packet carries the channel HASH in MeshPacket.channel, not the index", async () => {
  const { env } = await roundTrip({
    kind: "text", fromNode: 0x1, channelIndex: 3, channelName: "LongFast",
    channelKey: KEY, text: "hi", hopLimit: 3, wantAck: false, topicRoot: "msh",
  });
  const expected = channelHash("LongFast", expandKey(KEY));
  assert.equal(env.packet.channel, expected);
  assert.notEqual(env.packet.channel, 3, "must not be the channel index");
});

test("the downlink topic uses the broker root verbatim, with no region segment", async () => {
  for (const [root, want] of [
    ["msh", "msh/2/e/LongFast/!00000001"],
    ["msh/US/IN/NWI", "msh/US/IN/NWI/2/e/LongFast/!00000001"],
    ["msh/", "msh/2/e/LongFast/!00000001"], // trailing slash tolerated
  ] as const) {
    const enc = await encodeTx({
      kind: "text", fromNode: 0x1, channelIndex: 0, channelName: "LongFast",
      channelKey: KEY, text: "hi", hopLimit: 3, wantAck: false, topicRoot: root,
    });
    assert.equal(enc.topic, want);
  }
});

test("encodeTx refuses to publish when no topic root is known", async () => {
  await assert.rejects(
    () => encodeTx({
      kind: "text", fromNode: 0x1, channelIndex: 0, channelName: "LongFast",
      channelKey: KEY, text: "hi", hopLimit: 3, wantAck: false, topicRoot: "",
    }),
    /topic root/i,
  );
});

test("hopStart defaults to hopLimit but can be set for a faithful relayed uplink", async () => {
  const fresh = await roundTrip({
    kind: "text", fromNode: 0x1, channelIndex: 0, channelName: "LongFast",
    channelKey: KEY, text: "hi", hopLimit: 3, wantAck: false, topicRoot: "msh",
  });
  assert.equal(fresh.env.packet.hopStart, 3);
  assert.equal(fresh.env.packet.hopLimit, 3);
  // A message the patcher uplinks after 2 relays must not claim to be 0-hop direct.
  const relayed = await roundTrip({
    kind: "text", fromNode: 0x1, channelIndex: 0, channelName: "LongFast",
    channelKey: KEY, text: "hi", hopLimit: 1, hopStart: 3, wantAck: false, topicRoot: "msh",
  });
  assert.equal(relayed.env.packet.hopStart, 3);
  assert.equal(relayed.env.packet.hopLimit, 1);
});

// ---------------------------------------------------------------------------
// Channel wire names. An empty settings.name is resolved by the firmware, not blank.
// ---------------------------------------------------------------------------

test("an empty channel name resolves to the modem preset display name, not a placeholder", async () => {
  const { channelWireName, modemPresetDisplayName } = await import("../src/meshtastic/channelname.ts");
  // Byte-exact against DisplayFormatters::getModemPresetDisplayName, because this string is
  // xor-folded into the channel hash and published as ServiceEnvelope.channel_id.
  assert.equal(channelWireName("", "LONG_FAST"), "LongFast");
  assert.equal(channelWireName("", "LONG_MODERATE"), "LongMod", "long form is LongMod, not LongModerate");
  assert.equal(channelWireName("", "MEDIUM_SLOW"), "MediumSlow");
  // A named channel keeps its name.
  assert.equal(channelWireName("PCARC", "LONG_FAST"), "PCARC");
  // use_preset false means the firmware calls the channel "Custom".
  assert.equal(channelWireName("", "LONG_FAST", false), "Custom");
  // Presets the firmware's switch does not cover fall to its default arm.
  assert.equal(modemPresetDisplayName("VERY_LONG_SLOW"), "Invalid");
  assert.equal(modemPresetDisplayName(undefined), "Invalid");
});

test("the resolved name is what produces the channel hash a receiver matches", async () => {
  const { channelWireName } = await import("../src/meshtastic/channelname.ts");
  // A primary channel with an empty name on the default PSK hashes as "LongFast", which is also
  // the channel_id the gateway publishes, so the two agree and the packet decodes.
  const key = expandKey("AQ==")!;
  assert.equal(channelHash(channelWireName("", "LONG_FAST"), key), channelHash("LongFast", key));
  assert.notEqual(channelHash("(primary)", key), channelHash("LongFast", key));
});
