import { test } from "node:test";
import assert from "node:assert/strict";
import { create, toBinary } from "@bufbuild/protobuf";
import * as pb from "@meshtastic/protobufs";
import { decodeProtobufEnvelope, DecodeError, flattenTelemetry } from "../src/meshtastic/decode.ts";
import { portName } from "../src/meshtastic/portnum.ts";
import { expandKey, decryptPayload, channelHash } from "../src/meshtastic/crypto.ts";
import type { TopicInfo } from "../src/meshtastic/topic.ts";

// Fixtures are built with the real Meshtastic protobuf schemas (encode -> decode),
// exercising the actual ingest decode path. Covers decoded, encrypted, malformed,
// multi-gateway duplicate, and undecryptable (wrong key) cases (prompt requirement).

const KEYS = [{ name: "default", key: "AQ==" }];
const topic: TopicInfo = { isJson: false, isMap: false, channelId: "LongFast", gatewayIdFromTopic: 0xaaaa0001, root: "msh/US/2" };

function envelope(packet: any, gatewayId = "!aaaa0001") {
  const env = create((pb as any).Mqtt.ServiceEnvelopeSchema, { packet, channelId: "LongFast", gatewayId });
  return toBinary((pb as any).Mqtt.ServiceEnvelopeSchema, env);
}

function meshPacket(init: any) {
  return create((pb as any).Mesh.MeshPacketSchema, init);
}

test("decoded text packet normalizes header + payload", async () => {
  const data = create((pb as any).Mesh.DataSchema, { portnum: 1, payload: new TextEncoder().encode("hello mesh") });
  const bytes = envelope(
    meshPacket({ from: 0xbbbb0002, to: 0xffffffff, id: 0x1234, hopStart: 3, hopLimit: 3, rxRssi: -95, rxSnr: 6.5, payloadVariant: { case: "decoded", value: data } }),
  );
  const env = await decodeProtobufEnvelope(bytes, topic, KEYS);
  assert.equal(env.gatewayId, 0xaaaa0001);
  assert.equal(env.packet.from, 0xbbbb0002);
  assert.equal(env.packet.meshPacketId, 0x1234);
  assert.equal(env.packet.hopStart, 3);
  assert.equal(env.packet.hopLimit, 3);
  assert.equal(env.packet.rxRssi, -95);
  assert.equal(env.packet.decoded?.portnum, 1);
  assert.equal(env.packet.decoded?.parsed?.kind, "text");
  assert.equal((env.packet.decoded?.parsed as any).text, "hello mesh");
});

test("encrypted packet is decrypted with the default key", async () => {
  const pos = create((pb as any).Mesh.PositionSchema, { latitudeI: 415000000, longitudeI: -875000000, altitude: 200 });
  const inner = create((pb as any).Mesh.DataSchema, { portnum: 3, payload: toBinary((pb as any).Mesh.PositionSchema, pos) });
  const plain = toBinary((pb as any).Mesh.DataSchema, inner);
  const key = expandKey("AQ==")!;
  const packetId = 0x2222;
  const from = 0xcccc0003;
  const enc = decryptPayload(plain, key, packetId, from)!; // CTR is symmetric -> encrypt
  const bytes = envelope(meshPacket({ from, id: packetId, hopStart: 3, hopLimit: 2, rxRssi: -110, rxSnr: -2, payloadVariant: { case: "encrypted", value: enc } }));

  const env = await decodeProtobufEnvelope(bytes, topic, KEYS);
  assert.equal(env.packet.encrypted, null, "should have decrypted, not retained ciphertext");
  assert.equal(env.packet.decoded?.portnum, 3);
  assert.equal(env.packet.decoded?.parsed?.kind, "position");
  assert.ok(Math.abs((env.packet.decoded?.parsed as any).latitude - 41.5) < 1e-6);
});

test("malformed bytes throw DecodeError", async () => {
  const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x07, 0x41, 0x99]);
  await assert.rejects(() => decodeProtobufEnvelope(garbage, topic, KEYS), DecodeError);
});

test("same packet from two gateways decodes to distinct receptions", async () => {
  const data = create((pb as any).Mesh.DataSchema, { portnum: 1, payload: new TextEncoder().encode("dup") });
  const mk = (gw: string) => envelope(meshPacket({ from: 0xdddd0004, id: 0x3333, hopStart: 3, hopLimit: 3, rxRssi: -80, rxSnr: 9, payloadVariant: { case: "decoded", value: data } }), gw);
  const a = await decodeProtobufEnvelope(mk("!aaaa0001"), topic, KEYS);
  const b = await decodeProtobufEnvelope(mk("!bbbb0002"), topic, KEYS);
  assert.equal(a.packet.meshPacketId, b.packet.meshPacketId, "same logical packet id");
  assert.notEqual(a.gatewayId, b.gatewayId, "different gateway per reception");
});

test("undecryptable packet (wrong key) is retained for later re-decode", async () => {
  const inner = create((pb as any).Mesh.DataSchema, { portnum: 1, payload: new TextEncoder().encode("secret") });
  const plain = toBinary((pb as any).Mesh.DataSchema, inner);
  const realKey = expandKey("AQ==")!;
  const enc = decryptPayload(plain, realKey, 0x4444, 0xeeee0005)!;
  const bytes = envelope(meshPacket({ from: 0xeeee0005, id: 0x4444, hopStart: 3, hopLimit: 3, rxRssi: -100, rxSnr: 1, payloadVariant: { case: "encrypted", value: enc } }));

  const otherKey = Buffer.alloc(16, 0x42).toString("base64");
  const env = await decodeProtobufEnvelope(bytes, topic, [{ name: "other", key: otherKey }]);
  assert.equal(env.packet.decoded, null);
  assert.ok(env.packet.encrypted && env.packet.encrypted.length > 0, "ciphertext retained");
});

test("flattenTelemetry keeps canonical device/env keys", () => {
  const dev = flattenTelemetry({ variant: { case: "deviceMetrics", value: { batteryLevel: 88, voltage: 4.02, channelUtilization: 12.5, airUtilTx: 3.1, uptimeSeconds: 3600 } } });
  assert.equal(dev.battery_pct, 88);
  assert.equal(dev.voltage, 4.02);
  assert.equal(dev.chan_util, 12.5);
  assert.equal(dev.air_util_tx, 3.1);
  assert.equal(dev.uptime, 3600);
});

test("flattenTelemetry captures extended environment/power/air-quality/health metrics", () => {
  const env = flattenTelemetry({ variant: { case: "environmentMetrics", value: { temperature: 21.5, relativeHumidity: 55, barometricPressure: 1013.2, lux: 400, windSpeed: 3.2, gasResistance: 50000 } } });
  assert.equal(env.temperature, 21.5);
  assert.equal(env.humidity, 55);
  assert.equal(env.pressure, 1013.2);
  assert.equal(env.lux, 400);
  assert.equal(env.wind_speed, 3.2);
  assert.equal(env.gas_resistance, 50000);

  const pm = flattenTelemetry({ variant: { case: "powerMetrics", value: { ch1Voltage: 12.1, ch1Current: 0.5 } } });
  assert.equal(pm.ch1_voltage, 12.1);
  assert.equal(pm.ch1_current, 0.5);

  const aq = flattenTelemetry({ variant: { case: "airQualityMetrics", value: { pm25Standard: 8, co2: 415 } } });
  assert.equal(aq.pm25_standard, 8);
  assert.equal(aq.co2, 415);

  const hm = flattenTelemetry({ variant: { case: "healthMetrics", value: { temperature: 36.8, heartBpm: 72 } } });
  assert.equal(hm.health_temperature, 36.8, "health temperature namespaced to avoid env collision");
  assert.equal(hm.health_heart_bpm, 72);
});

test("flattenTelemetry ignores non-numeric fields and supports the flat shape", () => {
  const out = flattenTelemetry({ deviceMetrics: { batteryLevel: 50, someString: "x", nested: { a: 1 } } });
  assert.equal(out.battery_pct, 50);
  assert.equal("some_string" in out, false);
  assert.equal("nested" in out, false);
});

// ---------------------------------------------------------------------------
// Implicit-presence fields. rx_rssi, rx_snr and hop_start are proto3 scalars with
// IMPLICIT presence, so an omitted field decodes as 0 and cannot be told apart from
// a literal 0 at the protobuf layer. Reading 0 as a real value made two classifier
// branches unreachable: mqtt_injected (needs both RF fields null) and the
// hop_start-absent fallback. These pin the domain rules that recover presence.
// ---------------------------------------------------------------------------

test("a packet with no RF metadata reports null rssi/snr, so mqtt_injected stays reachable", async () => {
  const p = create((pb as any).Mesh.MeshPacketSchema, {
    from: 0x1234, to: 0xffffffff, id: 7, hopLimit: 3, hopStart: 3,
    payloadVariant: { case: "decoded", value: create((pb as any).Mesh.DataSchema, { portnum: 1, payload: new TextEncoder().encode("hi") }) },
  });
  const env = await decodeProtobufEnvelope(envelope(p), topic, KEYS);
  assert.equal(env.packet.rxRssi, null, "absent rx_rssi must be null, not 0");
  assert.equal(env.packet.rxSnr, null, "absent rx_snr must be null, not 0");
});

test("real RF metadata is preserved, including a genuine 0 dB SNR alongside a real RSSI", async () => {
  const p = create((pb as any).Mesh.MeshPacketSchema, {
    from: 0x1234, id: 8, rxRssi: -97, rxSnr: 0, hopLimit: 3, hopStart: 3,
    payloadVariant: { case: "decoded", value: create((pb as any).Mesh.DataSchema, { portnum: 1, payload: new TextEncoder().encode("hi") }) },
  });
  const env = await decodeProtobufEnvelope(envelope(p), topic, KEYS);
  assert.equal(env.packet.rxRssi, -97);
  assert.equal(env.packet.rxSnr, 0, "0 dB SNR is real when RSSI is present");
});

test("hop_start omitted (pre-2.3.0 firmware) reports null rather than an authoritative zero", async () => {
  // hop_start=0 and hop_limit=0 would otherwise compute hops_used=0 and be recorded as a
  // confirmed rf_direct, feeding false zero-hop links into every distance/link-budget number.
  const p = create((pb as any).Mesh.MeshPacketSchema, {
    from: 0x1234, id: 9, rxRssi: -100, hopLimit: 0,
    payloadVariant: { case: "decoded", value: create((pb as any).Mesh.DataSchema, { portnum: 1, payload: new TextEncoder().encode("hi") }) },
  });
  const env = await decodeProtobufEnvelope(envelope(p), topic, KEYS);
  assert.equal(env.packet.hopStart, null);
});

// ---------------------------------------------------------------------------
// JSON topic parity. Field names verified against the firmware's
// MeshPacketSerializer.cpp: it emits hops_away + hop_start (never hop_limit or
// relay_node), want_ack, and raw proto metric names in telemetry payloads.
// ---------------------------------------------------------------------------

const jsonTopic: TopicInfo = { isJson: true, isMap: false, channelId: "LongFast", gatewayIdFromTopic: 0xaaaa0001, root: "msh" };

test("JSON hop_limit is derived from hop_start - hops_away, so relayed packets are not 'direct'", async () => {
  const { decodeJsonEnvelope } = await import("../src/meshtastic/decode.ts");
  const env = decodeJsonEnvelope(
    { from: 0x1234, sender: "!aaaa0001", id: 5, type: "text", payload: { text: "hi" }, rssi: -100, snr: 4.5, hop_start: 3, hops_away: 2 },
    jsonTopic,
  );
  assert.equal(env.packet.hopStart, 3);
  assert.equal(env.packet.hopLimit, 1, "3 start - 2 away = 1 remaining");
  // With both present the classifier can now compute an authoritative 2-hop relay.
  assert.equal(env.packet.hopStart! - env.packet.hopLimit!, 2);
});

test("JSON want_ack is read, and a JSON-bodied text message is not dropped", async () => {
  const { decodeJsonEnvelope } = await import("../src/meshtastic/decode.ts");
  const ack = decodeJsonEnvelope({ from: 1, id: 1, type: "text", payload: "plain body", want_ack: true }, jsonTopic);
  assert.equal(ack.packet.wantAck, true);
  assert.equal((ack.packet.decoded?.parsed as any).text, "plain body");
  // A body that is itself JSON arrives as an object; re-stringify rather than dropping it.
  const bot = decodeJsonEnvelope({ from: 1, id: 2, type: "text", payload: { sensor: "t", v: 21.5 } }, jsonTopic);
  assert.equal(bot.packet.decoded?.portnum, 1);
  assert.equal((bot.packet.decoded?.parsed as any).text, '{"sensor":"t","v":21.5}');
});

test("JSON telemetry metrics are aliased to the canonical keys the alerts query", async () => {
  const { decodeJsonEnvelope } = await import("../src/meshtastic/decode.ts");
  const env = decodeJsonEnvelope(
    { from: 1, id: 3, type: "telemetry", payload: { battery_level: 82, channel_utilization: 7.5, uptime_seconds: 900, voltage: 4.01 } },
    jsonTopic,
  );
  const m = (env.packet.decoded?.parsed as any).metrics;
  assert.equal(m.battery_pct, 82, "battery_level must alias to battery_pct");
  assert.equal(m.chan_util, 7.5, "channel_utilization must alias to chan_util");
  assert.equal(m.uptime, 900);
  assert.equal(m.voltage, 4.01, "already-canonical names pass through");
});

test("a recognized-but-unparsed JSON type records its port instead of looking malformed", async () => {
  const { decodeJsonEnvelope } = await import("../src/meshtastic/decode.ts");
  for (const [type, port] of [["neighborinfo", 71], ["traceroute", 70], ["waypoint", 8]] as const) {
    const env = decodeJsonEnvelope({ from: 1, id: 4, type, payload: {} }, jsonTopic);
    assert.equal(env.packet.decoded?.portnum, port, `${type} should record port ${port}`);
  }
});

// ---------------------------------------------------------------------------
// MAP_REPORT_APP (port 73) and reply/reaction metadata (Data fields 7 and 8).
// Verified against firmware MQTT.cpp: the /2/map/ topic carries a full
// ServiceEnvelope whose MeshPacket holds a DECODED MapReport, so no key is used.
// ---------------------------------------------------------------------------

test("a map report decodes to identity, firmware and a coarse position", async () => {
  const report = create((pb as any).Mqtt.MapReportSchema, {
    longName: "Ridge Repeater", shortName: "RDGE", firmwareVersion: "2.5.4.abcdef",
    latitudeI: 415000000, longitudeI: -874000000, altitude: 310, positionPrecision: 13,
    numOnlineLocalNodes: 7,
  });
  const p = create((pb as any).Mesh.MeshPacketSchema, {
    from: 0xdeadbeef, to: 0xffffffff, id: 42, rxRssi: -88, hopLimit: 3, hopStart: 3,
    payloadVariant: { case: "decoded", value: create((pb as any).Mesh.DataSchema, {
      portnum: 73, payload: toBinary((pb as any).Mqtt.MapReportSchema, report),
    }) },
  });
  const env = await decodeProtobufEnvelope(envelope(p), topic, KEYS);
  const m = env.packet.decoded?.parsed as any;
  assert.equal(env.packet.decoded?.portnum, 73);
  assert.equal(m.kind, "mapreport");
  assert.equal(m.longName, "Ridge Repeater");
  assert.equal(m.firmwareVersion, "2.5.4.abcdef");
  assert.equal(Math.round(m.latitude * 1e4) / 1e4, 41.5);
  assert.equal(Math.round(m.longitude * 1e4) / 1e4, -87.4);
  assert.equal(m.altitudeM, 310);
  assert.equal(m.precisionBits, 13, "coarse by design; must not be treated as a GPS fix");
  assert.equal(m.numOnlineLocalNodes, 7);
});

test("a tapback reaction is flagged, and a plain message is not", async () => {
  const mk = async (extra: Record<string, unknown>) => {
    const p = create((pb as any).Mesh.MeshPacketSchema, {
      from: 0x1, id: 50, rxRssi: -90, hopLimit: 3, hopStart: 3,
      payloadVariant: { case: "decoded", value: create((pb as any).Mesh.DataSchema, {
        portnum: 1, payload: new TextEncoder().encode("thumbs"), ...extra,
      }) },
    });
    const env = await decodeProtobufEnvelope(envelope(p), topic, KEYS);
    return env.packet.decoded?.parsed as any;
  };
  // emoji != 0 means the body is a reaction to reply_id, not a typed message.
  const reaction = await mk({ emoji: 1, replyId: 0x1234 });
  assert.equal(reaction.isReaction, true);
  assert.equal(reaction.replyToPacketId, 0x1234);
  // A normal message carries neither, and must not be flagged.
  const plain = await mk({});
  assert.equal(plain.isReaction, undefined);
  assert.equal(plain.replyToPacketId, undefined);
  // A threaded reply that is NOT a reaction keeps the thread link only.
  const reply = await mk({ replyId: 0x99 });
  assert.equal(reply.isReaction, undefined);
  assert.equal(reply.replyToPacketId, 0x99);
});

// ---------------------------------------------------------------------------
// Key selection: MeshPacket.channel is an identity check, not a hint.
//
// The firmware never guesses. Router::perhapsDecode only tries a channel when
// Channels::decryptForHash finds getHash(chIndex) == p->channel, and that byte is on the wire for
// every encrypted-variant uplink (MQTT.cpp publishes the pre-decryption copy). Guessing by payload
// shape instead accepted wrong-key garbage roughly 1 in 4,000-17,000 attempts per key, and the
// accept is permanent: the packets upsert pins decode_status='decoded'.
// ---------------------------------------------------------------------------

const KEY_A = Buffer.alloc(16, 0x11).toString("base64");
const KEY_B = Buffer.alloc(16, 0x22).toString("base64");

function envelopeWithChannel(packet: any, channelId: string) {
  const env = create((pb as any).Mqtt.ServiceEnvelopeSchema, { packet, channelId, gatewayId: "!aaaa0001" });
  return toBinary((pb as any).Mqtt.ServiceEnvelopeSchema, env);
}

function encryptedPacket(plain: Uint8Array, keyB64: string, channel: number, extra: any = {}) {
  const key = expandKey(keyB64);
  const id = 0x5150;
  const from = 0xdddd0007;
  const enc = key ? decryptPayload(plain, key, id, from)! : plain; // CTR is symmetric
  return meshPacket({ from, id, channel, hopStart: 3, hopLimit: 3, rxRssi: -90, rxSnr: 5, payloadVariant: { case: "encrypted", value: enc }, ...extra });
}

function dataBytes(init: any) {
  return toBinary((pb as any).Mesh.DataSchema, create((pb as any).Mesh.DataSchema, init));
}

test("a key whose channel hash does not match MeshPacket.channel is never tried", async () => {
  const plain = dataBytes({ portnum: 1, payload: new TextEncoder().encode("on channel B") });
  // Really encrypted with B, but the wire says the sender used A. The firmware would skip B, so
  // HopWatch must too: matching the payload shape instead is what fabricates decodes.
  const bytes = envelopeWithChannel(encryptedPacket(plain, KEY_B, channelHash("chanA", expandKey(KEY_A))), "chanA");
  const env = await decodeProtobufEnvelope(bytes, topic, [
    { name: "chanA", key: KEY_A },
    { name: "chanB", key: KEY_B },
  ]);
  assert.equal(env.packet.decoded, null, "must not fall back to a key the hash rules out");
  assert.ok(env.packet.encrypted, "stays encrypted");
});

test("the matching-hash key decodes, and the ciphertext is retained anyway", async () => {
  const plain = dataBytes({ portnum: 1, payload: new TextEncoder().encode("on channel B") });
  const bytes = envelopeWithChannel(encryptedPacket(plain, KEY_B, channelHash("chanB", expandKey(KEY_B))), "chanB");
  const env = await decodeProtobufEnvelope(bytes, topic, [
    { name: "chanA", key: KEY_A },
    { name: "chanB", key: KEY_B },
  ]);
  assert.equal((env.packet.decoded?.parsed as any)?.text, "on channel B");
  assert.equal(env.packet.encrypted, null, "decoded, so not flagged undecodable");
  // Retained regardless of the apparent decode: an accept is pinned permanently by the packets
  // upsert and nothing re-decodes, so this is the only copy that could ever correct a wrong key.
  assert.ok(env.packet.cipherText && env.packet.cipherText.length > 0, "ciphertext kept for re-decode");
});

test("an empty payload on a known port is rejected when no configured key matches the hash", async () => {
  // Exactly the shape every measured false accept took: two bytes that decode as Data{portnum:4}
  // with no payload. With no hash to lean on, a plausible portnum byte is not evidence.
  const bytes = envelopeWithChannel(encryptedPacket(dataBytes({ portnum: 4 }), KEY_B, 0), "chanB");
  const env = await decodeProtobufEnvelope(bytes, topic, [{ name: "chanB", key: KEY_B }]);
  assert.equal(env.packet.decoded, null);
  assert.ok(env.packet.encrypted, "stays encrypted for later re-decode");
});

test("an empty payload IS accepted when want_response marks it a request", async () => {
  // Traceroute/position/telemetry requests legitimately carry no payload, and all set want_response.
  const bytes = envelopeWithChannel(encryptedPacket(dataBytes({ portnum: 70, wantResponse: true }), KEY_B, 0), "chanB");
  const env = await decodeProtobufEnvelope(bytes, topic, [{ name: "chanB", key: KEY_B }]);
  assert.equal(env.packet.decoded?.portnum, 70);
});

test("a PSK-less channel's plaintext is decoded (ham mode / unencrypted channel)", async () => {
  // Channels.cpp sets k.length = 0 for PSK index 0, CryptoEngine::encryptPacket is then a no-op,
  // and Router::perhapsEncode still sends the encrypted variant with channel = xorHash(name). The
  // payload is plaintext Data sitting in the ciphertext slot; it used to be permanently opaque.
  const plain = dataBytes({ portnum: 1, payload: new TextEncoder().encode("in the clear") });
  const bytes = envelopeWithChannel(encryptedPacket(plain, "", channelHash("ham", null)), "ham");
  const env = await decodeProtobufEnvelope(bytes, topic, [{ name: "ham", key: "" }]);
  assert.equal((env.packet.decoded?.parsed as any)?.text, "in the clear");
});

test("PKI traffic is not run against channel keys", async () => {
  const plain = dataBytes({ portnum: 1, payload: new TextEncoder().encode("dm") });
  const hash = channelHash("chanB", expandKey(KEY_B));
  const keys = [{ name: "chanB", key: KEY_B }];
  // Curve25519 + AES-CCM can never be opened by a PSK, so every attempt is pure false-accept risk.
  // The gateway flags it two ways: channel_id "PKI" on the envelope, and MeshPacket.pki_encrypted.
  const byChannelId = await decodeProtobufEnvelope(envelopeWithChannel(encryptedPacket(plain, KEY_B, hash), "PKI"), topic, keys);
  assert.equal(byChannelId.packet.decoded, null, "channel_id PKI must short-circuit the key loop");
  assert.equal(byChannelId.channelId, "PKI");

  const byFlag = await decodeProtobufEnvelope(
    envelopeWithChannel(encryptedPacket(plain, KEY_B, hash, { pkiEncrypted: true, publicKey: new Uint8Array(32).fill(7) }), "chanB"),
    topic,
    keys,
  );
  assert.equal(byFlag.packet.decoded, null, "pki_encrypted must short-circuit the key loop");
  assert.equal(byFlag.packet.pkiEncrypted, true);
  assert.equal(byFlag.packet.publicKey?.length, 32);
});

// ---------------------------------------------------------------------------
// Telemetry variant coverage, and the environment/battery metric collision.
// ---------------------------------------------------------------------------

test("EnvironmentMetrics voltage/current are namespaced away from the battery series", () => {
  // Firmware's INA219/226/260/3221 sensors all write a measured BUS voltage (a 12 V solar rail, a
  // 5 V USB rail) into environment_metrics.voltage. Sharing the metric name with DeviceMetrics
  // voltage made the battery death-curve fit and the low-battery alert read an INA rail.
  const env = flattenTelemetry({ variant: { case: "environmentMetrics", value: { temperature: 21.5, relativeHumidity: 55, voltage: 12.6, current: 850 } } });
  assert.equal(env.temperature, 21.5);
  assert.equal(env.humidity, 55);
  assert.equal(env.env_voltage, 12.6);
  assert.equal(env.env_current, 850);
  assert.equal(env.voltage, undefined, "must not land on the battery metric");
  assert.equal(env.current, undefined);

  // The device's own voltage is still the battery, under the name the alert and forecast read.
  const dev = flattenTelemetry({ variant: { case: "deviceMetrics", value: { batteryLevel: 88, voltage: 4.02 } } });
  assert.equal(dev.voltage, 4.02);
  assert.equal(dev.battery_pct, 88);
});

test("LocalStats and HostMetrics variants are captured under their own prefixes", () => {
  // Both were dropped entirely. A prefix is required, not cosmetic: LocalStats carries its own
  // uptime_seconds / channel_utilization / air_util_tx, which would otherwise be swallowed by the
  // "never overwrite a canonical key" guard or pollute the device-metric charts.
  const ls = flattenTelemetry({
    variant: { case: "localStats", value: { numOnlineNodes: 42, numTotalNodes: 310, numTxRelay: 1200, numTxRelayCanceled: 7, noiseFloor: -102, uptimeSeconds: 99, channelUtilization: 12.5 } },
  });
  assert.equal(ls.ls_num_online_nodes, 42);
  assert.equal(ls.ls_num_total_nodes, 310);
  assert.equal(ls.ls_num_tx_relay, 1200, "identifies a de-facto backbone router even when role says CLIENT");
  assert.equal(ls.ls_noise_floor, -102);
  assert.equal(ls.uptime, undefined, "LocalStats uptime must not overwrite the device uptime series");
  assert.equal(ls.chan_util, undefined);

  const host = flattenTelemetry({ variant: { case: "hostMetrics", value: { uptimeSeconds: 864000, freememBytes: 512, load1: 42, diskfree1Bytes: 900 } } });
  assert.equal(host.host_uptime_seconds, 864000);
  assert.equal(host.host_load1, 42);
  assert.equal(host.uptime, undefined);
});

test("detection and alert bodies are decoded, and kept apart from chat", async () => {
  // The firmware's own "is this a text message" test covers ports 1, 10 and 11 alike, so the body
  // needs no extra protobuf work; HopWatch counted the port and threw the payload away. Keeping
  // them as a distinct kind is what stops a door sensor appearing in /messages and being eligible
  // for the RF<->MQTT text patcher.
  for (const [port, kind] of [[10, "detection"], [11, "alert"]] as const) {
    const data = create((pb as any).Mesh.DataSchema, { portnum: port, payload: new TextEncoder().encode("front door opened") });
    const env = await decodeProtobufEnvelope(
      envelope(meshPacket({ from: 0xdead0001, to: 0xffffffff, id: 0x3210, hopStart: 3, hopLimit: 3, rxRssi: -80, rxSnr: 9, payloadVariant: { case: "decoded", value: data } })),
      topic, KEYS,
    );
    assert.equal(env.packet.decoded?.portnum, port);
    assert.equal(env.packet.decoded?.parsed?.kind, "sensor", `port ${port} must not be dropped`);
    assert.equal((env.packet.decoded?.parsed as any).sensorKind, kind);
    assert.equal((env.packet.decoded?.parsed as any).text, "front door opened");
    assert.notEqual(env.packet.decoded?.parsed?.kind, "text", "must not be treated as a chat message");
  }
});

test("the port table matches the upstream proto, including the values a summary omitted", () => {
  // An audit summary of portnums.proto claimed the highest value was 79 and silently dropped
  // GROUPALARM_APP = 112 plus nine others. The table is also evidence in the decode fallback's
  // acceptance test, so a missing port makes legitimate traffic harder to accept.
  for (const [port, name] of [
    [11, "ALERT_APP"], [12, "KEY_VERIFICATION_APP"], [13, "REMOTE_SHELL_APP"],
    [35, "STORE_FORWARD_PLUSPLUS_APP"], [36, "NODE_STATUS_APP"], [37, "MESH_BEACON_APP"],
    [75, "LORAWAN_BRIDGE"], [76, "RETICULUM_TUNNEL_APP"], [77, "CAYENNE_APP"],
    [78, "ATAK_PLUGIN_V2"], [79, "LORA_OTA_APP"], [112, "GROUPALARM_APP"],
  ] as const) {
    assert.equal(portName(port), name, `port ${port}`);
  }
});

test("key-verification stage is inferred from which hash is present", async () => {
  // The nonce correlates one handshake; the stage is implied by the hashes. Neither hash is the
  // requester's opening message, hash2 alone is the responder's intermediary, and hash1 is the
  // requester's closing authoritative hash. A nonce that never reaches `final` did not complete.
  const cases: [Record<string, unknown>, string][] = [
    [{ nonce: 42n }, "request"],
    [{ nonce: 42n, hash2: new Uint8Array([1, 2, 3]) }, "response"],
    [{ nonce: 42n, hash1: new Uint8Array([9, 9]) }, "final"],
  ];
  for (const [init, stage] of cases) {
    const kv = create((pb as any).Mesh.KeyVerificationSchema, init);
    const data = create((pb as any).Mesh.DataSchema, { portnum: 12, payload: toBinary((pb as any).Mesh.KeyVerificationSchema, kv) });
    const env = await decodeProtobufEnvelope(
      envelope(meshPacket({ from: 0xfeed0001, to: 0xfeed0002, id: 0x4321, hopStart: 3, hopLimit: 3, rxRssi: -70, rxSnr: 11, payloadVariant: { case: "decoded", value: data } })),
      topic, KEYS,
    );
    assert.equal(env.packet.decoded?.parsed?.kind, "keyverification");
    assert.equal((env.packet.decoded?.parsed as any).stage, stage);
    assert.equal((env.packet.decoded?.parsed as any).nonce, 42);
  }
});
