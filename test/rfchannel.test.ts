import { test } from "node:test";
import assert from "node:assert/strict";
import { create, toBinary } from "@bufbuild/protobuf";
import * as pb from "@meshtastic/protobufs";
import { decodeNodeFrame, type NodeChannelNames } from "../src/meshtastic/decode.ts";
import { channelWireName } from "../src/meshtastic/channelname.ts";
import { expandKey, channelHash, decryptPayload } from "../src/meshtastic/crypto.ts";

// Channel identity on the station-node RF path.
//
// This is what makes the sanctioned RF->MQTT patcher work at all. The firmware decrypts before
// handing a packet to the stream API and rewrites MeshPacket.channel to the LOCAL CHANNEL INDEX
// (Router.cpp: `p->channel = chIndex; // change to store the index instead of the hash`), so a
// decoded RF frame carries an index and no name. HopWatch used to record channel_id = NULL for every
// such packet, and the patcher looks the channel key up BY NAME: it therefore logged "no key for
// channel (none)" and refused to uplink every genuinely RF-only message, which is the one case the
// patcher exists for.

const m = pb as any;

function nodeFrame(init: any): Uint8Array {
  return toBinary(m.Mesh.FromRadioSchema, create(m.Mesh.FromRadioSchema, init));
}

function decodedPacket(channel: number, text: string, extra: any = {}) {
  const data = create(m.Mesh.DataSchema, { portnum: 1, payload: new TextEncoder().encode(text), bitfield: 1 });
  return create(m.Mesh.MeshPacketSchema, {
    from: 0xabcd0001, to: 0xffffffff, id: 0x7777, channel, hopStart: 3, hopLimit: 3,
    rxRssi: -88, rxSnr: 7, payloadVariant: { case: "decoded", value: data }, ...extra,
  });
}

test("a channel frame from the node's own config dump names the channel", async () => {
  const ch = create(m.Channel.ChannelSchema, {
    index: 2, role: 2, settings: create(m.Channel.ChannelSettingsSchema, { name: "PCARC" }),
  });
  const msg = await decodeNodeFrame(nodeFrame({ payloadVariant: { case: "channel", value: ch } }), [], 1);
  assert.ok(msg && msg.kind === "channel");
  assert.equal((msg as any).index, 2);
  assert.equal((msg as any).name, "PCARC");
  assert.equal((msg as any).role, 2);
});

test("the lora config frame yields the modem preset that names an unnamed channel", async () => {
  const lora = create(m.Config.Config_LoRaConfigSchema, { usePreset: true, modemPreset: 0 /* LONG_FAST */ });
  const cfg = create(m.Config.ConfigSchema, { payloadVariant: { case: "lora", value: lora } });
  const msg = await decodeNodeFrame(nodeFrame({ payloadVariant: { case: "config", value: cfg } }), [], 1);
  assert.ok(msg && msg.kind === "modemPreset");
  assert.equal((msg as any).preset, "LONG_FAST");
  assert.equal((msg as any).usePreset, true);
  // Which is what turns the empty primary-channel name into the identity the mesh actually uses.
  assert.equal(channelWireName("", (msg as any).preset, true), "LongFast");
});

test("a decoded RF packet is named from the node's channel table, not left NULL", async () => {
  const names: NodeChannelNames = new Map([[0, "LongFast"], [2, "PCARC"]]);
  const frame = await decodeNodeFrame(nodeFrame({ payloadVariant: { case: "packet", value: decodedPacket(2, "hi from RF") } }), [], 0xaaaa, names);
  assert.ok(frame && frame.kind === "packet");
  assert.equal(frame.env.channelId, "PCARC", "without this the RF->MQTT patcher has no key to look up");
  assert.equal(frame.env.packet.decoded?.portnum, 1);
  assert.equal(frame.env.packet.okToMqtt, true, "the sender's consent bit survives, it gates the uplink");
  // The byte is an index here, not a hash, and must not be stored as though it were interchangeable.
  assert.equal(frame.env.packet.channel, 2);
  assert.equal(frame.env.packet.channelIsHash, false);
});

test("an index the node has no channel for stays unnamed rather than guessing", async () => {
  const names: NodeChannelNames = new Map([[0, "LongFast"]]);
  const frame = await decodeNodeFrame(nodeFrame({ payloadVariant: { case: "packet", value: decodedPacket(5, "?") } }), [], 0xaaaa, names);
  assert.ok(frame && frame.kind === "packet");
  assert.equal(frame.env.channelId, "", "naming it after the wrong channel would be worse than not naming it");
});

test("a PKI DM the node decrypted is reported as PKI, not as the primary channel", async () => {
  // perhapsDecode's PKI branch leaves chIndex at 0, so `p->channel = 0`. Mapping that through the
  // channel table would label a private DM with the primary channel's name.
  const names: NodeChannelNames = new Map([[0, "LongFast"]]);
  const pkt = decodedPacket(0, "dm", { to: 0xaaaa, pkiEncrypted: true, publicKey: new Uint8Array(32).fill(3) });
  const frame = await decodeNodeFrame(nodeFrame({ payloadVariant: { case: "packet", value: pkt } }), [], 0xaaaa, names);
  assert.ok(frame && frame.kind === "packet");
  assert.equal(frame.env.channelId, "PKI");
  assert.equal(frame.env.packet.pkiEncrypted, true);
});

test("an RF frame the node could NOT decrypt is still named by the key that opens it", async () => {
  // Here MeshPacket.channel really is the hash (perhapsDecode never got to rewrite it), so the
  // channel table must not be consulted: the matching key's name is the authority.
  const key = expandKey("AQ==")!;
  const inner = create(m.Mesh.DataSchema, { portnum: 1, payload: new TextEncoder().encode("secret") });
  const plain = toBinary(m.Mesh.DataSchema, inner);
  const id = 0x9999, from = 0xbbbb0002;
  const enc = decryptPayload(plain, key, id, from)!; // CTR is symmetric
  const pkt = create(m.Mesh.MeshPacketSchema, {
    from, id, channel: channelHash("LongFast", key), hopStart: 3, hopLimit: 3, rxRssi: -101, rxSnr: 2,
    payloadVariant: { case: "encrypted", value: enc },
  });
  const names: NodeChannelNames = new Map([[0, "SomethingElse"]]);
  const frame = await decodeNodeFrame(nodeFrame({ payloadVariant: { case: "packet", value: pkt } }), [{ name: "LongFast", key: "AQ==" }], 0xaaaa, names);
  assert.ok(frame && frame.kind === "packet");
  assert.equal(frame.env.channelId, "LongFast");
  assert.equal(frame.env.packet.channelIsHash, true, "an encrypted variant carries the hash, so it is not an index");
});
