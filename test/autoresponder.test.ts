import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesPattern, formatAutoReply, fillTemplate, pickReplyTemplate, triggerAllowedOnChannel } from "../src/lib/autoresponder.ts";

test("triggerAllowedOnChannel: empty list = any channel", () => {
  assert.equal(triggerAllowedOnChannel([], "Testing"), true);
  assert.equal(triggerAllowedOnChannel(undefined, null), true);
});

test("triggerAllowedOnChannel: scoped trigger fires only on listed channels", () => {
  assert.equal(triggerAllowedOnChannel(["Testing"], "Testing"), true);
  assert.equal(triggerAllowedOnChannel(["Testing"], "testing"), true, "case-insensitive");
  assert.equal(triggerAllowedOnChannel(["Testing"], "LongFast"), false);
  assert.equal(triggerAllowedOnChannel(["Testing"], null), false, "unknown channel does not match a scoped trigger");
});

test("matchesPattern matches the trimmed body case-insensitively", () => {
  assert.equal(matchesPattern("ping", "^ping$"), true);
  assert.equal(matchesPattern("  PING  ", "^ping$"), true);
  assert.equal(matchesPattern("ping me", "^ping$"), false);
  assert.equal(matchesPattern("status now", "status"), true);
});

test("an unanchored word pattern matches anywhere, any case, on a word boundary", () => {
  assert.equal(matchesPattern("this is a TEST", "\\btest\\b"), true);
  assert.equal(matchesPattern("Test 123", "\\btest\\b"), true);
  assert.equal(matchesPattern("tEsT!", "\\btest\\b"), true);
  assert.equal(matchesPattern("latest news", "\\btest\\b"), false, "word boundary excludes 'latest'");
  assert.equal(matchesPattern("please TEST it", "test"), true, "bare substring matches any case");
});

test("matchesPattern is safe against empty and malformed patterns", () => {
  assert.equal(matchesPattern("ping", ""), false);
  assert.equal(matchesPattern("ping", "("), false, "invalid regex never matches, never throws");
});

test("formatAutoReply includes observed link quality, degrades gracefully", () => {
  assert.equal(formatAutoReply(-95, 6.5, 0), "pong (rssi -95dBm, snr 6.5, 0 hops)");
  assert.equal(formatAutoReply(-80, null, 2), "pong (rssi -80dBm, 2 hops)");
  assert.equal(formatAutoReply(null, null, null), "pong");
});

// ---------------------------------------------------------------------------
// reply_channel: pin a channel reply to a channel the node can actually transmit on.
//
// HopWatch may hold a KEY for a channel (so it decodes traffic there) that the station node is not
// a MEMBER of, so it cannot transmit on it. A "channel" reply that echoes the incoming channel is
// then refused. reply_channel forces the reply onto a channel the node holds (e.g. LongFast).
// ---------------------------------------------------------------------------

test("reply channel selection: reply_channel wins, else incoming, else first keyed", async () => {
  const { pickReplyChannel } = await import("../src/worker/autoresponder.ts");
  const keyed = new Set(["LongFast", "default", "PCARC"]);
  // reply_channel set and keyed -> used, even when the message arrived on another channel.
  assert.equal(pickReplyChannel(keyed, "LongFast", "default"), "LongFast");
  // reply_channel blank -> fall back to the incoming channel (historical behaviour).
  assert.equal(pickReplyChannel(keyed, "", "default"), "default");
  // reply_channel set but NOT keyed -> skip it, fall back to incoming.
  assert.equal(pickReplyChannel(keyed, "Nonexistent", "PCARC"), "PCARC");
  // neither keyed -> first keyed channel, never null when we hold any key.
  assert.equal(pickReplyChannel(keyed, "", "unknownchan"), "LongFast");
  // no keys at all -> null (caller must handle; the worker fails the row rather than TX blind).
  assert.equal(pickReplyChannel(new Set<string>(), "LongFast", "default"), null);
});

// ---------------------------------------------------------------------------
// reply_transport: answer a node on the link it was heard on.
//
// tx.transport is fixed to the node (RF), so an auto-reply always went out over RF -- but a "test"
// heard only over MQTT (a node several hops away, not an RF neighbour) cannot be reached by an RF
// broadcast, so those testers got no answer. "match" routes the reply by how the trigger arrived.
// ---------------------------------------------------------------------------

test("reply targets: match answers on the transport the trigger was heard on", async () => {
  const { pickReplyTargets } = await import("../src/worker/autoresponder.ts");
  // Heard on RF -> reply via the station node.
  assert.deepEqual(pickReplyTargets("match", true, "NWIMesh", "node", "NWIMesh"), [{ transport: "node", brokerId: null }]);
  // Heard via MQTT -> reply on the broker it arrived on (so a downlink gateway near them re-airs it).
  assert.deepEqual(pickReplyTargets("match", false, "Chicago", "node", "NWIMesh"), [{ transport: "mqtt", brokerId: "Chicago" }]);
  // MQTT-heard with no source broker recorded -> fall back to the configured TX broker.
  assert.deepEqual(pickReplyTargets("match", false, null, "node", "NWIMesh"), [{ transport: "mqtt", brokerId: "NWIMesh" }]);
});

test("reply targets: both sends on RF and MQTT; fixed keeps the TX transport", async () => {
  const { pickReplyTargets } = await import("../src/worker/autoresponder.ts");
  assert.deepEqual(pickReplyTargets("both", true, "NWIMesh", "node", "NWIMesh"),
    [{ transport: "node", brokerId: null }, { transport: "mqtt", brokerId: "NWIMesh" }]);
  // fixed ignores how it was heard: always the configured TX transport.
  assert.deepEqual(pickReplyTargets("fixed", false, "Chicago", "node", "NWIMesh"), [{ transport: "node", brokerId: null }]);
  assert.deepEqual(pickReplyTargets("fixed", true, "Chicago", "mqtt", "NWIMesh"), [{ transport: "mqtt", brokerId: "NWIMesh" }]);
});

// ---------------------------------------------------------------------------
// Separate RF / MQTT reply text. An MQTT-heard trigger has no RF rssi/snr, so a template that uses
// {rssi}/{snr} renders "? dBm / ? dB". The MQTT reply template omits those tokens; the worker picks
// it based on how the trigger was heard.
// ---------------------------------------------------------------------------

test("a template with {rssi}/{snr} renders ? when there is no RF signal (MQTT-heard)", () => {
  const out = fillTemplate("ack {short}: {rssi} dBm / {snr} dB, {hops} hop(s) via {via}", {
    name: null, short: null, id: "!0d5c11bb", rssi: null, snr: null, hops: 3, via: "MQTT", msg: "test", count: 5, time: "01:14 PM",
  });
  assert.ok(out.includes("? dBm"), "this is the weird-looking case the MQTT template avoids");
});

test("an MQTT reply template that omits the signal tokens has no stray ?", () => {
  const out = fillTemplate("ack {short}: {hops} hop(s) via MQTT @ {time}", {
    name: null, short: null, id: "!0d5c11bb", rssi: null, snr: null, hops: 3, via: "MQTT", msg: "test", count: 5, time: "01:14 PM",
  });
  assert.equal(out, "ack !0d5c11bb: 3 hop(s) via MQTT @ 01:14 PM");
  assert.ok(!out.includes("?"), "no meaningless ? for a node heard over MQTT");
});

// ---------------------------------------------------------------------------
// Template SELECTION by transport. The worker must actually pick reply_mqtt for an MQTT-heard
// message; the fillTemplate tests above prove the text, this proves the choice (the step that was
// silently skipped, so an MQTT ack still rendered "? dBm / ? dB").
// ---------------------------------------------------------------------------

test("pickReplyTemplate uses reply_mqtt for an MQTT-heard message when it is set", () => {
  const trig = { reply: "ack {rssi} dBm", reply_mqtt: "ack {hops} hop(s) via MQTT" };
  assert.equal(pickReplyTemplate(trig, false), "ack {hops} hop(s) via MQTT");
});

test("pickReplyTemplate uses reply for an RF-heard message even when reply_mqtt is set", () => {
  const trig = { reply: "ack {rssi} dBm", reply_mqtt: "ack {hops} hop(s) via MQTT" };
  assert.equal(pickReplyTemplate(trig, true), "ack {rssi} dBm");
});

test("pickReplyTemplate falls back to reply when reply_mqtt is blank or absent", () => {
  assert.equal(pickReplyTemplate({ reply: "ack {rssi}", reply_mqtt: "" }, false), "ack {rssi}");
  assert.equal(pickReplyTemplate({ reply: "ack {rssi}" }, false), "ack {rssi}");
});
