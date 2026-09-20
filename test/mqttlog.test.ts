import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMosquittoLog, connectedClients, classifyClient } from "../src/lib/mqttlog.ts";

const SAMPLE = [
  "1788567451: New connection from 71.57.35.152:55534 on port 1883.",
  "1788567451: New client connected from 71.57.35.152:55534 as MeshtasticAndroidMqttProxy-!040641d4-uuid (p5, c1, k30, u'meshdev').",
  "1788567460: New client connected from 10.0.0.5:40001 as hopwatch-NWIMesh (p5, c1, k60, u'meshdev').",
  "1788567470: New client connected from 8.8.8.8:2000 as !16cd7858 (p4, c1, k300).",
  "1788567480: Client !16cd7858 closed its connection.",
  "1788567490: Client MeshtasticAndroidMqttProxy-!040641d4-uuid has exceeded timeout, disconnecting.",
  "1788567500: New client connected from 71.57.35.152:55999 as MeshtasticAndroidMqttProxy-!040641d4-uuid2 (p5, c1, k30, u'meshdev').",
  "1788567510: Client <unknown> closed its connection.",
];

test("parseMosquittoLog extracts connect and disconnect events, ignoring <unknown> and pre-connect", () => {
  const ev = parseMosquittoLog(SAMPLE.join("\n"));
  const connects = ev.filter((e) => e.kind === "connect");
  const disconnects = ev.filter((e) => e.kind === "disconnect");
  assert.equal(connects.length, 4);
  assert.equal(disconnects.length, 2); // the <unknown> line is dropped
  assert.equal(connects[0]!.ip, "71.57.35.152");
  assert.equal(connects[0]!.keepalive, 30);
  assert.equal(connects[0]!.username, "meshdev");
  assert.equal(connects[2]!.username, undefined); // anonymous connect (no u'...')
});

test("connectedClients returns only currently-connected, newest session wins", () => {
  const cs = connectedClients(parseMosquittoLog(SAMPLE.join("\n")));
  const ids = cs.map((c) => c.clientId).sort();
  // !16cd7858 connected then closed -> gone. The android proxy reconnected under a new id -> present.
  assert.deepEqual(ids, ["MeshtasticAndroidMqttProxy-!040641d4-uuid2", "hopwatch-NWIMesh"]);
  const proxy = cs.find((c) => c.clientId.startsWith("MeshtasticAndroid"))!;
  assert.equal(proxy.connectedAt, 1788567500);
});

test("classifyClient identifies apps, nodes, hopwatch, and other", () => {
  assert.deepEqual(classifyClient("MeshtasticAndroidMqttProxy-!040641d4-uuid"), { kind: "app (android)", node: "!040641d4" });
  assert.deepEqual(classifyClient("MeshtasticAppleMqttProxy-!3dea81f7-UUID"), { kind: "app (apple)", node: "!3dea81f7" });
  assert.deepEqual(classifyClient("hopwatch-NWIMesh"), { kind: "hopwatch", node: null });
  assert.deepEqual(classifyClient("!16cd7858"), { kind: "node", node: "!16cd7858" });
  assert.deepEqual(classifyClient("CENSYS"), { kind: "other", node: null });
});
