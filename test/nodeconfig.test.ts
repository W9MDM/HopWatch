import { test } from "node:test";
import assert from "node:assert/strict";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import * as pb from "@meshtastic/protobufs";
import { decodeFromRadio, type FromRadioMsg } from "../src/meshtastic/decode.ts";
import { WRITABLE_FIELDS, WRITE_ONLY_FIELDS, buildWriteVariants, type RawSections, type NodeWriteOp } from "../src/node/writeconfig.ts";

// Station-node config read/write fidelity.
//
// The firmware assigns a set_config section WHOLESALE (AdminModule.cpp: `config.lora =
// validatedLora`, `config.position = c.payload_variant.position`, `moduleConfig.mqtt =
// c.payload_variant.mqtt`), so a section rebuilt from only the fields HopWatch models zeroes
// everything else on the device. Writes must therefore be a read-modify-write on the section the
// node itself reported, and every key the write path reads has to be a key the read path emits.

const m = pb as any;

function fromRadio(init: any): Uint8Array {
  return toBinary(m.Mesh.FromRadioSchema, create(m.Mesh.FromRadioSchema, init));
}

async function decodeConfig(section: string, value: any): Promise<Extract<FromRadioMsg, { kind: "config" }>> {
  const msg = await decodeFromRadio(
    fromRadio({ payloadVariant: { case: "config", value: create(m.Config.ConfigSchema, { payloadVariant: { case: section, value } }) } }),
  );
  assert.ok(msg && msg.kind === "config", `expected a config message for ${section}`);
  return msg as Extract<FromRadioMsg, { kind: "config" }>;
}

test("position config is read as snake_case keys the editor and write path can use", async () => {
  const pos = create(m.Config.Config_PositionConfigSchema, {
    positionBroadcastSecs: 900, positionBroadcastSmartEnabled: true, fixedPosition: true,
    gpsUpdateInterval: 120, gpsMode: 1 /* ENABLED */, positionFlags: 811,
    broadcastSmartMinimumDistance: 100, broadcastSmartMinimumIntervalSecs: 30,
  });
  const msg = await decodeConfig("position", pos);
  assert.equal(msg.section, "position");
  assert.equal(msg.values.position_broadcast_secs, 900);
  assert.equal(msg.values.position_broadcast_smart_enabled, true);
  assert.equal(msg.values.fixed_position, true);
  assert.equal(msg.values.gps_update_interval, 120);
  assert.equal(msg.values.gps_mode, "ENABLED", "an enum name, so the dropdown and the write path agree");
  assert.equal(msg.values.position_flags, 811);
  // No camelCase leakage: those keys are what the editor could not read, and reading them as
  // undefined is what wrote gps_mode=DISABLED and cleared the stored position on the device.
  assert.equal(msg.values.gpsMode, undefined);
  assert.equal(msg.values.positionBroadcastSecs, undefined);
});

test("every key the write path reads is a key the read path emits", async () => {
  // Guard for a whole bug class: a key the write path reads but the read path never emits is
  // silently absent, and (before the read-modify-write) wrote a protobuf default over the real
  // value on the device. Position was exactly this, in the destructive direction.
  const sections: [string, string, any][] = [
    ["config.lora", "lora", create(m.Config.Config_LoRaConfigSchema, { usePreset: true, region: 1, modemPreset: 0, hopLimit: 3, txPower: 30, txEnabled: true, channelNum: 20, sx126xRxBoostedGain: true, configOkToMqtt: true, ignoreMqtt: true })],
    ["config.device", "device", create(m.Config.Config_DeviceConfigSchema, { role: 1, rebroadcastMode: 1, nodeInfoBroadcastSecs: 10800 })],
    ["config.position", "position", create(m.Config.Config_PositionConfigSchema, { positionBroadcastSecs: 900, positionBroadcastSmartEnabled: true, fixedPosition: true, gpsUpdateInterval: 120, gpsMode: 1, positionFlags: 811, broadcastSmartMinimumDistance: 100, broadcastSmartMinimumIntervalSecs: 30 })],
  ];
  for (const [key, section, value] of sections) {
    const msg = await decodeConfig(section, value);
    for (const field of WRITABLE_FIELDS[key]!) {
      if (WRITE_ONLY_FIELDS.has(field)) continue;
      assert.ok(field in msg.values, `${key}: write path reads "${field}" but the read path does not emit it`);
    }
  }
  const mqtt = create(m.ModuleConfig.ModuleConfig_MQTTConfigSchema, {
    enabled: true, address: "a", username: "u", password: "p", root: "r",
    encryptionEnabled: true, jsonEnabled: true, tlsEnabled: true, proxyToClientEnabled: true, mapReportingEnabled: true,
  });
  const mqttMsg = await decodeFromRadio(
    fromRadio({ payloadVariant: { case: "moduleConfig", value: create(m.ModuleConfig.ModuleConfigSchema, { payloadVariant: { case: "mqtt", value: mqtt } }) } }),
  );
  assert.ok(mqttMsg && mqttMsg.kind === "moduleConfig");
  for (const field of WRITABLE_FIELDS["moduleConfig.mqtt"]!) {
    if (WRITE_ONLY_FIELDS.has(field)) continue;
    assert.ok(field in (mqttMsg as any).values, `moduleConfig.mqtt: write path reads "${field}" but the read path does not emit it`);
  }
  // A write-only field must still be ACCOUNTED for: the read path reports whether it is set, so the
  // UI can say "configured" without ever handling the value. Silently dropping it is not the same
  // as deliberately not returning it.
  for (const field of WRITE_ONLY_FIELDS) {
    assert.ok(!(field in (mqttMsg as any).values), `"${field}" is a credential and must never be returned`);
    assert.ok(`has_${field}` in (mqttMsg as any).values, `the read path must report has_${field}`);
  }
});

test("the station node's credentials are never returned in a config snapshot", async () => {
  // /api/v1/admin/node/config returns this snapshot to the browser, and the TX manager renders the
  // first keys of every module_config section, so a plaintext broker password was printed into the
  // DOM. config.network.wifi_psk went out in the JSON through the generic scalar fallback.
  const mqtt = create(m.ModuleConfig.ModuleConfig_MQTTConfigSchema, {
    enabled: true, address: "mqtt.example.org", username: "hopwatch", password: "sup3r-s3cret",
  });
  const mqttMsg = await decodeFromRadio(
    fromRadio({ payloadVariant: { case: "moduleConfig", value: create(m.ModuleConfig.ModuleConfigSchema, { payloadVariant: { case: "mqtt", value: mqtt } }) } }),
  );
  assert.ok(mqttMsg && mqttMsg.kind === "moduleConfig");
  const mv = (mqttMsg as any).values;
  assert.equal(mv.password, undefined);
  assert.equal(mv.has_password, true, "presence is reportable, the value is not");
  assert.equal(mv.username, "hopwatch", "non-secret fields are unaffected");
  assert.ok(!JSON.stringify(mv).includes("sup3r-s3cret"));

  const net = create(m.Config.Config_NetworkConfigSchema, { wifiEnabled: true, wifiSsid: "mesh", wifiPsk: "wifi-p@ss" });
  const netMsg = await decodeConfig("network", net);
  const nv = netMsg.values as Record<string, unknown>;
  assert.equal(nv.wifiPsk, undefined);
  assert.equal(nv.wifi_psk, undefined);
  assert.equal(nv.has_wifi_psk, true);
  // Snake_case now, from the schema descriptor: the generic projection covers every arm.
  assert.equal(nv.wifi_ssid, "mesh");
  assert.ok(!JSON.stringify(nv).includes("wifi-p@ss"));
});

test("a one-field LoRa edit preserves every field HopWatch does not model", async () => {
  // The exact scenario: a node with a custom frequency, duty-cycle override, frequency offset and
  // ignore list, where the operator changes only the hop limit.
  const lora = create(m.Config.Config_LoRaConfigSchema, {
    usePreset: true, region: 1, modemPreset: 0, hopLimit: 3, txPower: 30, txEnabled: true,
    overrideFrequency: 906.875, overrideDutyCycle: true, channelNum: 52, frequencyOffset: 1.5,
    ignoreIncoming: [0x1234abcd], paFanDisabled: true, sx126xRxBoostedGain: true,
  });
  const msg = await decodeConfig("lora", lora);
  const raws: RawSections = { config: new Map([["lora", msg.raw]]), moduleConfig: new Map(), channels: new Map() };
  const ops: NodeWriteOp[] = [{ kind: "config", section: "lora", values: { hop_limit: 5 } }];
  const [variant] = buildWriteVariants(m, ops, raws) as any[];
  const section = variant.value.payloadVariant.value;
  assert.equal(section.hopLimit, 5, "the edited field changed");
  assert.equal(section.overrideFrequency, 906.875, "unmodelled field preserved");
  assert.equal(section.overrideDutyCycle, true);
  assert.equal(section.channelNum, 52);
  assert.equal(section.frequencyOffset, 1.5);
  assert.deepEqual([...section.ignoreIncoming], [0x1234abcd]);
  assert.equal(section.paFanDisabled, true);
});

test("even fields the pinned protobuf schema does not know are preserved through a write", async () => {
  // The installed @meshtastic/protobufs can always lag the firmware, so a real node can report
  // fields this build cannot name (EnvironmentMetrics' ADC and 1-Wire channels are newer than the
  // published package today, for instance). Rebuilding a section from the modelled keys dropped
  // them; cloning the reported message carries them through as unknown fields, which is what keeps
  // a config write honest across a schema-version gap regardless of when the package was pinned.
  const lora = create(m.Config.Config_LoRaConfigSchema, { usePreset: true, hopLimit: 3, txPower: 30 });
  const known = toBinary(m.Config.Config_LoRaConfigSchema, lora);
  // Append field 200, varint 42: a field number no version of the schema in this repo defines.
  const unknownField = Uint8Array.from([0xc0, 0x0c, 42]);
  const doctored = new Uint8Array(known.length + unknownField.length);
  doctored.set(known, 0); doctored.set(unknownField, known.length);
  const raw = fromBinary(m.Config.Config_LoRaConfigSchema, doctored);

  const raws: RawSections = { config: new Map([["lora", raw]]), moduleConfig: new Map(), channels: new Map() };
  const [variant] = buildWriteVariants(m, [{ kind: "config", section: "lora", values: { hop_limit: 7 } }], raws) as any[];
  const section = variant.value.payloadVariant.value;
  assert.equal(section.hopLimit, 7);
  const out = toBinary(m.Config.Config_LoRaConfigSchema, section);
  assert.ok(
    Buffer.from(out).includes(Buffer.from(unknownField)),
    "the unknown field survived clone + re-encode",
  );
});

test("a position edit that does not mention gps_mode leaves the GPS alone", async () => {
  // Writing the section wholesale with gps_mode defaulted to 0 (DISABLED) made the firmware both
  // switch the GPS off and call clearLocalPosition(), erasing the stored position.
  const pos = create(m.Config.Config_PositionConfigSchema, { gpsMode: 1, positionBroadcastSecs: 900, gpsUpdateInterval: 30, positionFlags: 811 });
  const msg = await decodeConfig("position", pos);
  const raws: RawSections = { config: new Map([["position", msg.raw]]), moduleConfig: new Map(), channels: new Map() };
  const [variant] = buildWriteVariants(m, [{ kind: "config", section: "position", values: { gps_update_interval: 60 } }], raws) as any[];
  const section = variant.value.payloadVariant.value;
  assert.equal(section.gpsUpdateInterval, 60);
  assert.equal(section.gpsMode, 1, "GPS stays ENABLED");
  assert.equal(section.positionBroadcastSecs, 900);
  assert.equal(section.positionFlags, 811);
});

test("a write refuses rather than defaulting when the node did not report the section", () => {
  const empty: RawSections = { config: new Map(), moduleConfig: new Map(), channels: new Map() };
  assert.throws(
    () => buildWriteVariants(m, [{ kind: "config", section: "position", values: { gps_update_interval: 60 } }], empty),
    /did not report its position config/,
    "silently writing protobuf defaults is the failure mode, so refusing is correct",
  );
});

test("a channel toggle preserves the channel name, PSK, role and precision", async () => {
  const psk = new Uint8Array(32).fill(0x5a);
  const channel = create(m.Channel.ChannelSchema, {
    index: 2, role: 2,
    settings: create(m.Channel.ChannelSettingsSchema, {
      name: "PCARC", psk, uplinkEnabled: false, downlinkEnabled: false,
      moduleSettings: create(m.Channel.ModuleSettingsSchema, { positionPrecision: 13 }),
    }),
  });
  const msg = await decodeFromRadio(fromRadio({ payloadVariant: { case: "channel", value: channel } }));
  assert.ok(msg && msg.kind === "channel");
  const raws: RawSections = { config: new Map(), moduleConfig: new Map(), channels: new Map([[2, (msg as any).raw]]) };
  const [variant] = buildWriteVariants(m, [{ kind: "channel", index: 2, uplink_enabled: true, downlink_enabled: false }], raws) as any[];
  const ch = variant.value;
  assert.equal(ch.settings.uplinkEnabled, true, "the toggle applied");
  assert.equal(ch.settings.downlinkEnabled, false);
  assert.equal(ch.settings.name, "PCARC", "name preserved, not replaced by a placeholder");
  assert.deepEqual([...ch.settings.psk], [...psk], "PSK round-trips without ever leaving the device");
  assert.equal(ch.role, 2);
  assert.equal(ch.settings.moduleSettings.positionPrecision, 13);
});

// ---------------------------------------------------------------------------
// Every config arm, not just the four that were hand-mapped.
//
// The generic fallback copied protobuf-es camelCase keys and left enums as raw numbers, dropping
// nested and repeated fields entirely, so 8 of 10 Config arms and 16 of 17 ModuleConfig arms were
// present-but-unreadable. Projecting from the schema descriptor covers them all at once and keeps
// working as the protobuf package moves.
// ---------------------------------------------------------------------------

test("an unmapped Config arm is projected as snake_case with resolved enums", async () => {
  const net = create(m.Config.Config_NetworkConfigSchema, { wifiEnabled: true, wifiSsid: "mesh", ntpServer: "pool.ntp.org" });
  const msg = await decodeConfig("network", net);
  assert.equal(msg.values.wifi_enabled, true, "snake_case, not wifiEnabled");
  assert.equal(msg.values.wifi_ssid, "mesh");
  assert.equal(msg.values.ntp_server, "pool.ntp.org");
  assert.equal(msg.values.wifiEnabled, undefined, "no camelCase leakage");
});

test("repeated and nested fields survive, and enums resolve to their upstream names", async () => {
  const lora = create(m.Config.Config_LoRaConfigSchema, {
    usePreset: true, modemPreset: 3 /* MEDIUM_SLOW */, region: 1 /* US */,
    ignoreIncoming: [0x1234abcd, 0x0000beef], hopLimit: 4,
  });
  const msg = await decodeConfig("lora", lora);
  // lora is one of the hand-mapped arms, so check the generic projection directly too.
  const generic = await decodeConfig("power", create(m.Config.Config_PowerConfigSchema, { isPowerSaving: true, waitBluetoothSecs: 60 }));
  assert.equal(generic.values.is_power_saving, true);
  assert.equal(generic.values.wait_bluetooth_secs, 60);

  const display = await decodeConfig("display", create(m.Config.Config_DisplayConfigSchema, { screenOnSecs: 30, units: 1 /* IMPERIAL */ }));
  assert.equal(display.values.screen_on_secs, 30);
  assert.equal(display.values.units, "IMPERIAL", "an enum must resolve to its upstream name, not a raw 1");

  const bt = await decodeConfig("bluetooth", create(m.Config.Config_BluetoothConfigSchema, { enabled: true, mode: 1, fixedPin: 123456 }));
  assert.equal(bt.values.enabled, true);
  assert.equal(typeof bt.values.mode, "string", `mode should be an enum name, got ${JSON.stringify(bt.values.mode)}`);

  // A repeated scalar is kept as an array rather than dropped.
  const raw = msg.raw as any;
  assert.ok(Array.isArray(raw.ignoreIncoming) && raw.ignoreIncoming.length === 2, "raw keeps the list for the write path");
});

test("an unmapped ModuleConfig arm is projected the same way", async () => {
  const sf = create(m.ModuleConfig.ModuleConfig_StoreForwardConfigSchema, { enabled: true, historyReturnMax: 25, records: 100 });
  const msg = await decodeFromRadio(
    fromRadio({ payloadVariant: { case: "moduleConfig", value: create(m.ModuleConfig.ModuleConfigSchema, { payloadVariant: { case: "storeForward", value: sf } }) } }),
  );
  assert.ok(msg && msg.kind === "moduleConfig");
  const v = (msg as any).values;
  assert.equal(v.enabled, true);
  assert.equal(v.history_return_max, 25);
  assert.equal(v.records, 100);
  assert.equal(v.historyReturnMax, undefined);
});

test("an unmapped section is writable from the schema, preserving the rest", async () => {
  // Hand-written specs covered 4 of 27 sections. Deriving coercion from the schema means the rest
  // are writable without 23 more tables that would drift out of sync with the read projection.
  const display = create(m.Config.Config_DisplayConfigSchema, { screenOnSecs: 30, units: 0, flipScreen: true, compassNorthTop: true });
  const msg = await decodeConfig("display", display);
  const raws: RawSections = { config: new Map([["display", msg.raw]]), moduleConfig: new Map(), channels: new Map() };
  const [variant] = buildWriteVariants(m, [{ kind: "config", section: "display", values: { screen_on_secs: 90, units: "IMPERIAL" } }], raws) as any[];
  const out = variant.value.payloadVariant.value;
  assert.equal(out.screenOnSecs, 90, "the named scalar changed");
  assert.equal(out.units, 1, "an enum NAME from the read path coerces back to its number");
  assert.equal(out.flipScreen, true, "unnamed fields preserved from the node's own report");
  assert.equal(out.compassNorthTop, true);
});

test("an unmapped module section is writable the same way", async () => {
  const sf = create(m.ModuleConfig.ModuleConfig_StoreForwardConfigSchema, { enabled: true, records: 100, historyReturnMax: 25, heartbeat: true });
  const msg = await decodeFromRadio(
    fromRadio({ payloadVariant: { case: "moduleConfig", value: create(m.ModuleConfig.ModuleConfigSchema, { payloadVariant: { case: "storeForward", value: sf } }) } }),
  );
  assert.ok(msg && msg.kind === "moduleConfig");
  const raws: RawSections = { config: new Map(), moduleConfig: new Map([["storeForward", (msg as any).raw]]), channels: new Map() };
  const [variant] = buildWriteVariants(m, [{ kind: "moduleConfig", section: "storeForward", values: { records: 250 } }], raws) as any[];
  const out = variant.value.payloadVariant.value;
  assert.equal(out.records, 250);
  assert.equal(out.historyReturnMax, 25, "preserved");
  assert.equal(out.heartbeat, true, "preserved");
});

test("an unknown section name is refused, not silently written somewhere else", () => {
  const empty: RawSections = { config: new Map(), moduleConfig: new Map(), channels: new Map() };
  assert.throws(
    () => buildWriteVariants(m, [{ kind: "config", section: "nonexistent", values: { x: 1 } }], empty),
    /unknown config section/,
  );
});
