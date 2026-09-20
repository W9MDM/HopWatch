import net from "node:net";
import { randomBytes } from "node:crypto";
import { create, clone, toBinary } from "@bufbuild/protobuf";
import { parseFrames } from "./frame.ts";
import { frame as frameStream } from "./frame.ts";
import { encodeWantConfig } from "../meshtastic/encode.ts";
import { decodeFromRadio } from "../meshtastic/decode.ts";
import { withNodeLease } from "../db/nodelease.ts";
import { planNodeDbPrune } from "../lib/nodedb.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Write a station node's configuration over the Meshtastic stream API using AdminMessages, the
// same admin protocol MeshMonitor/the app use. This talks to the DIRECTLY-CONNECTED node (local
// session), so it applies to that node only and does NOT transmit over RF -- it is a device
// operation like readNodeConfig, not gated by the TX arm/rails.
//
// Flow: connect -> want_config (to learn myNodeNum) -> begin_edit_settings -> one AdminMessage
// per change -> commit_edit_settings -> optional reboot. Each AdminMessage is a MeshPacket to
// ourself on ADMIN_APP (port 6), decoded (unencrypted local admin).

const ADMIN_PORT = 6;

// A single admin change. `kind` selects the AdminMessage oneof; `value` is the section message
// contents (plain object matched to the protobuf field names by the builder).
export type NodeWriteOp =
  | { kind: "owner"; longName: string; shortName: string }
  // Any Config / ModuleConfig oneof arm. The four with curated specs keep them; the rest are applied
  // from the protobuf schema, which is also how the read path projects them.
  | { kind: "config"; section: string; values: Record<string, unknown> }
  | { kind: "moduleConfig"; section: string; values: Record<string, unknown> }
  // A channel op carries only what changed. Everything else (name, PSK, role, precision) is
  // preserved from the node's own dump, so the key never has to be read out and passed back in.
  | { kind: "channel"; index: number; uplink_enabled?: boolean; downlink_enabled?: boolean }
  // Create or replace a whole channel at an index: sets name + PSK + role, the way the phone app and
  // meshtastic CLI do. Used to provision a new channel (e.g. a Testing channel) so the station node
  // can decode, transmit and ack on it. If a channel already exists at the index its module settings
  // are preserved; name/PSK/role/uplink/downlink are set from the op.
  | { kind: "channelSet"; index: number; name: string; psk: string; role?: "PRIMARY" | "SECONDARY" | "DISABLED"; uplink_enabled?: boolean; downlink_enabled?: boolean };

/**
 * The section messages the node reported in its want_config dump, keyed the way readNodeConfig
 * keys them. Every write is a read-modify-write on these, because the firmware replaces a config
 * section WHOLESALE: `config.device = c.payload_variant.device`, `config.position =
 * c.payload_variant.position`, `config.lora = validatedLora`, `moduleConfig.mqtt =
 * c.payload_variant.mqtt` (AdminModule.cpp). A section rebuilt from only the fields HopWatch
 * models therefore zeroes every field it does not: a one-field hop-limit edit used to wipe
 * override_frequency, channel_num, override_duty_cycle, ignore_incoming, fem_lna_mode and the
 * rest, and a channel write used to need the PSK round-tripped through the write route.
 */
export interface RawSections {
  config: Map<string, unknown>;
  moduleConfig: Map<string, unknown>;
  channels: Map<number, unknown>;
}

let pbMod: any = null;
async function pb(): Promise<any> {
  if (!pbMod) pbMod = await import("@meshtastic/protobufs");
  return pbMod;
}

/** Channel role wire numbers (Channel.Role). Stable protocol constants, so they are hardcoded
 * rather than resolved through the protobuf enum by name. */
const CHANNEL_ROLE_NUM: Record<string, number> = { DISABLED: 0, PRIMARY: 1, SECONDARY: 2 };

/**
 * Decode a channel PSK spec into the raw key bytes the firmware stores. Accepts the same shapes the
 * meshtastic CLI/app do:
 *   "" / "none"        -> no encryption (empty PSK)
 *   "default" / "basic"-> the 1-byte PSK [1], which selects the well-known public default key
 *   "random"           -> a fresh 256-bit key
 *   base64             -> a 1, 16 or 32 byte key (1 byte = a default-key variant selector)
 * The default and 16/32-byte cases are the only ones a channel actually uses in the wild.
 */
export function decodeChannelPsk(v: string): Uint8Array {
  const s = (v ?? "").trim();
  const lower = s.toLowerCase();
  if (s === "" || lower === "none") return new Uint8Array(0);
  if (lower === "default" || lower === "basic") return new Uint8Array([1]);
  if (lower === "random") return new Uint8Array(randomBytes(32));
  const buf = Buffer.from(s, "base64");
  if (buf.length !== 1 && buf.length !== 16 && buf.length !== 32) {
    throw new Error(`channel PSK must be a base64 key of 1, 16 or 32 bytes (got ${buf.length}); use "default" for the basic key or "none" for no encryption`);
  }
  return new Uint8Array(buf);
}

/** Map an enum NAME (as read back by readconfig) to its numeric value, or pass through a number. */
function enumVal(enumObj: any, v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return v;
  const n = enumObj?.[v as string];
  return typeof n === "number" ? n : undefined;
}

// Field specs: snake_case key (as readNodeConfig reports it and the editor sends it) -> the
// protobuf-es camelCase field name plus a converter. Only keys PRESENT in the op are assigned, so
// an unmentioned field keeps whatever the node already had.
type FieldSpec = Record<string, [camel: string, conv: (v: unknown, m: any) => unknown]>;

const num = (v: unknown): unknown => numOrU(v);
const bool = (v: unknown): unknown => !!v;
const text = (v: unknown): unknown => str(v);

const LORA_FIELDS: FieldSpec = {
  use_preset: ["usePreset", (v) => v !== false],
  region: ["region", (v, m) => enumVal(m.Config.Config_LoRaConfig_RegionCode, v)],
  modem_preset: ["modemPreset", (v, m) => enumVal(m.Config.Config_LoRaConfig_ModemPreset, v)],
  hop_limit: ["hopLimit", num],
  tx_power: ["txPower", num],
  tx_enabled: ["txEnabled", (v) => v !== false],
  channel_num: ["channelNum", num],
  sx126x_rx_boosted_gain: ["sx126xRxBoostedGain", bool],
  config_ok_to_mqtt: ["configOkToMqtt", bool],
  ignore_mqtt: ["ignoreMqtt", bool],
};

const DEVICE_FIELDS: FieldSpec = {
  role: ["role", (v, m) => enumVal(m.Config.Config_DeviceConfig_Role, v)],
  rebroadcast_mode: ["rebroadcastMode", (v, m) => enumVal(m.Config.Config_DeviceConfig_RebroadcastMode, v)],
  node_info_broadcast_secs: ["nodeInfoBroadcastSecs", num],
};

const POSITION_FIELDS: FieldSpec = {
  position_broadcast_secs: ["positionBroadcastSecs", num],
  position_broadcast_smart_enabled: ["positionBroadcastSmartEnabled", bool],
  fixed_position: ["fixedPosition", bool],
  gps_update_interval: ["gpsUpdateInterval", num],
  gps_mode: ["gpsMode", (v, m) => enumVal(m.Config.Config_PositionConfig_GpsMode, v)],
  position_flags: ["positionFlags", num],
  broadcast_smart_minimum_distance: ["broadcastSmartMinimumDistance", num],
  broadcast_smart_minimum_interval_secs: ["broadcastSmartMinimumIntervalSecs", num],
};

const MQTT_FIELDS: FieldSpec = {
  enabled: ["enabled", bool],
  address: ["address", text],
  username: ["username", text],
  password: ["password", text],
  root: ["root", text],
  encryption_enabled: ["encryptionEnabled", bool],
  json_enabled: ["jsonEnabled", bool],
  tls_enabled: ["tlsEnabled", bool],
  proxy_to_client_enabled: ["proxyToClientEnabled", bool],
  map_reporting_enabled: ["mapReportingEnabled", bool],
};

const CONFIG_SPECS: Record<string, [FieldSpec, (m: any) => any]> = {
  lora: [LORA_FIELDS, (m) => m.Config.Config_LoRaConfigSchema],
  device: [DEVICE_FIELDS, (m) => m.Config.Config_DeviceConfigSchema],
  position: [POSITION_FIELDS, (m) => m.Config.Config_PositionConfigSchema],
};

/** Find a oneof arm's message descriptor by name, so any section can be addressed generically. */
function armSchema(schema: any, arm: string): any {
  for (const f of schema?.fields ?? []) {
    if (f.localName === arm || f.name === arm) return f.message;
  }
  return undefined;
}

/**
 * Apply snake_case values to a section using the protobuf schema's own field metadata.
 *
 * This is what makes the arms beyond lora/device/position/mqtt writable at all. Hand-written specs
 * covered 4 of 27 sections, and the read side is now schema-projected for all of them, so the write
 * side derives its coercion the same way instead of needing 23 more tables that would drift.
 *
 * Only SCALARS, enums and repeated scalars are assignable, and only fields the caller names: a
 * nested message is left exactly as the node reported it, which is what the read-modify-write is
 * for. An enum accepts either its upstream NAME (what the read path emits) or its number.
 */
function applySchemaFields(schema: any, target: any, values: Record<string, unknown>): string[] {
  const applied: string[] = [];
  for (const f of schema?.fields ?? []) {
    const key: string = f.name ?? f.localName;
    if (!(key in values)) continue;
    const raw = values[key];
    if (raw === undefined) continue;
    if (f.fieldKind === "enum") {
      const n = typeof raw === "number" ? raw : enumNumber(f.enum, String(raw));
      if (n === undefined) continue;
      target[f.localName] = n;
    } else if (f.fieldKind === "list") {
      if (!Array.isArray(raw)) continue;
      target[f.localName] = raw
        .map((x) => (f.listKind === "enum" ? enumNumber(f.enum, String(x)) : Number(x)))
        .filter((x): x is number => x !== undefined && Number.isFinite(x));
    } else if (f.fieldKind === "message") {
      continue; // preserved from the node's own report
    } else if (typeof f.scalar === "number" && f.scalar === 8) {
      target[f.localName] = Boolean(raw); // bool
    } else if (typeof raw === "string" && Number.isNaN(Number(raw)) === false && typeof target[f.localName] === "number") {
      target[f.localName] = Number(raw);
    } else if (typeof target[f.localName] === "boolean") {
      target[f.localName] = Boolean(raw);
    } else if (typeof target[f.localName] === "string") {
      target[f.localName] = String(raw);
    } else {
      const n = Number(raw);
      target[f.localName] = Number.isFinite(n) ? n : target[f.localName];
    }
    applied.push(key);
  }
  return applied;
}

/** An enum value's number from its upstream NAME, or undefined when the name is unknown. */
function enumNumber(desc: any, name: string): number | undefined {
  for (const [num, v] of Object.entries(desc?.values ?? {})) {
    if ((v as any)?.name === name) return Number(num);
  }
  const n = Number(name);
  return Number.isFinite(n) ? n : undefined;
}

/** Ops whose current section the node has not (yet) reported. The write must not proceed while any
 * remain: building on protobuf defaults is what wipes unmodelled fields. */
function missingRaws(ops: NodeWriteOp[], raws: RawSections): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op.kind === "config" && !raws.config.has(op.section)) out.push(`${op.section} config`);
    else if (op.kind === "moduleConfig" && !raws.moduleConfig.has(op.section)) out.push(`${op.section} module config`);
    else if (op.kind === "channel" && !raws.channels.has(op.index)) out.push(`channel ${op.index}`);
  }
  return out;
}

/** Assign the fields the op actually names onto an already-populated section message. */
function applyFields(m: any, target: any, spec: FieldSpec, values: Record<string, unknown>): void {
  for (const [snake, [camel, conv]] of Object.entries(spec)) {
    if (!(snake in values)) continue;
    const next = conv(values[snake], m);
    if (next !== undefined) target[camel] = next;
  }
}

/**
 * Start from the section the node reported and overlay the changes. Refuses rather than falling
 * back to protobuf defaults: a write built on defaults silently reverts every unmodelled field on
 * the device, which is exactly the failure this exists to prevent.
 */
function baseSection(m: any, raw: unknown, schema: any, what: string): any {
  if (raw === undefined || raw === null) {
    throw new Error(`the node did not report its ${what} in the config dump, so writing it would reset the fields HopWatch does not model; retry the write`);
  }
  return clone(schema, raw as never);
}

/** The snake_case keys each writable section accepts, keyed as `<kind>.<section>`. Exported so a
 * static test can assert that every key the write path reads is actually produced by the read path;
 * a mismatch is silent and destructive, because an unreadable key writes a protobuf default. */
/**
 * Fields that can be WRITTEN to the node but are never read back, because they are credentials and
 * the snapshot is returned to the browser (see REDACTED_CONFIG_KEYS in src/meshtastic/decode.ts).
 * The read path reports `has_<field>` instead. A write op simply omits the field to keep whatever
 * the device already has, which the read-modify-write preserves without the value ever leaving it.
 */
export const WRITE_ONLY_FIELDS = new Set(["password"]);

export const WRITABLE_FIELDS: Record<string, string[]> = {
  "config.lora": Object.keys(LORA_FIELDS),
  "config.device": Object.keys(DEVICE_FIELDS),
  "config.position": Object.keys(POSITION_FIELDS),
  "moduleConfig.mqtt": Object.keys(MQTT_FIELDS),
};

/** Build every op's payloadVariant against the node's reported sections. Exported for tests; the
 * write path calls it once, before it sends anything, so a missing section aborts the whole batch
 * rather than leaving a half-applied edit between begin_edit and commit_edit. */
export function buildWriteVariants(m: any, ops: NodeWriteOp[], raws: RawSections): unknown[] {
  return ops.map((op) => buildVariant(m, op, raws));
}

/** Build the payloadVariant for one op (typed against the installed protobufs). */
function buildVariant(m: any, op: NodeWriteOp, raws: RawSections): any {
  switch (op.kind) {
    case "owner": {
      const user = create(m.Mesh.UserSchema, { longName: op.longName, shortName: op.shortName });
      return { case: "setOwner", value: user };
    }
    case "config": {
      const entry = CONFIG_SPECS[op.section];
      const schema = entry ? entry[1](m) : armSchema(m.Config.ConfigSchema, op.section);
      if (!schema) throw new Error(`unknown config section "${op.section}"`);
      const section = baseSection(m, raws.config.get(op.section), schema, `${op.section} config`);
      // The curated spec still wins where one exists (it carries the deliberate "absent means keep"
      // semantics for the controls the UI offers); every other arm is applied from the schema.
      if (entry) applyFields(m, section, entry[0], op.values);
      else applySchemaFields(schema, section, op.values);
      return { case: "setConfig", value: create(m.Config.ConfigSchema, { payloadVariant: { case: op.section, value: section } }) };
    }
    case "moduleConfig": {
      const schema = op.section === "mqtt"
        ? m.ModuleConfig.ModuleConfig_MQTTConfigSchema
        : armSchema(m.ModuleConfig.ModuleConfigSchema, op.section);
      if (!schema) throw new Error(`unknown module config section "${op.section}"`);
      const section = baseSection(m, raws.moduleConfig.get(op.section), schema, `${op.section} module config`);
      if (op.section === "mqtt") applyFields(m, section, MQTT_FIELDS, op.values);
      else applySchemaFields(schema, section, op.values);
      return { case: "setModuleConfig", value: create(m.ModuleConfig.ModuleConfigSchema, { payloadVariant: { case: op.section, value: section } }) };
    }
    case "channel": {
      // Cloning the node's own Channel keeps the name, PSK, role and module settings byte-exact, so
      // the key never leaves the device and an empty (preset-resolved) name is not overwritten with
      // a placeholder.
      const ch = baseSection(m, raws.channels.get(op.index), m.Channel.ChannelSchema, `channel ${op.index}`);
      if (!ch.settings) ch.settings = create(m.Channel.ChannelSettingsSchema, {});
      if (op.uplink_enabled !== undefined) ch.settings.uplinkEnabled = !!op.uplink_enabled;
      if (op.downlink_enabled !== undefined) ch.settings.downlinkEnabled = !!op.downlink_enabled;
      return { case: "setChannel", value: ch };
    }
    case "channelSet": {
      // Create or replace the channel at this index. Clone the node's existing channel when it has
      // one (to keep module_settings), otherwise build a fresh Channel. Then set name/PSK/role and
      // the uplink/downlink toggles from the op. This is exactly how the app provisions a channel.
      const existing = raws.channels.get(op.index);
      const ch: any = existing
        ? clone(m.Channel.ChannelSchema, existing as never)
        : create(m.Channel.ChannelSchema, {});
      ch.index = op.index;
      if (!ch.settings) ch.settings = create(m.Channel.ChannelSettingsSchema, {});
      ch.settings.name = op.name ?? "";
      ch.settings.psk = decodeChannelPsk(op.psk);
      const role = CHANNEL_ROLE_NUM[op.role ?? ""] ?? (op.index === 0 ? CHANNEL_ROLE_NUM.PRIMARY : CHANNEL_ROLE_NUM.SECONDARY);
      ch.role = role;
      if (op.uplink_enabled !== undefined) ch.settings.uplinkEnabled = !!op.uplink_enabled;
      if (op.downlink_enabled !== undefined) ch.settings.downlinkEnabled = !!op.downlink_enabled;
      return { case: "setChannel", value: ch };
    }
  }
}

/**
 * Wrap a payloadVariant into an AdminMessage, stamping the session passkey. Firmware 2.5+ requires
 * the passkey (obtained from a get_*_response) on every set_* command, or it silently drops the
 * write. An empty passkey is sent for older firmware that neither issues nor checks one.
 */
function mkAdmin(m: any, payloadVariant: any, passkey: Uint8Array | null): any {
  return create(m.Admin.AdminMessageSchema, { payloadVariant, ...(passkey && passkey.length ? { sessionPasskey: passkey } : {}) });
}

function numOrU(v: unknown): number | undefined { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function str(v: unknown): string { return v === undefined || v === null ? "" : String(v); }

/** Wrap an AdminMessage in a framed ToRadio addressed to our own node on ADMIN_APP. */
function frameAdmin(m: any, myNodeNum: number, admin: any, wantResponse = false): Uint8Array {
  const data = create(m.Mesh.DataSchema, { portnum: ADMIN_PORT, payload: toBinary(m.Admin.AdminMessageSchema, admin), wantResponse });
  const packet = create(m.Mesh.MeshPacketSchema, {
    from: myNodeNum >>> 0, to: myNodeNum >>> 0, id: randomBytes(4).readUInt32LE(0) >>> 0,
    wantAck: true, payloadVariant: { case: "decoded", value: data },
  });
  const toRadio = create(m.Mesh.ToRadioSchema, { payloadVariant: { case: "packet", value: packet } });
  return frameStream(toBinary(m.Mesh.ToRadioSchema, toRadio));
}

/** Apply a batch of config changes to the connected node. Reboots afterward only if asked. */
export async function applyNodeConfig(host: string, port: number, ops: NodeWriteOp[], reboot = false): Promise<void> {
  if (!host) throw new Error("no node host configured");
  // Nothing to do only when there are no edits AND no reboot; a reboot-only call is valid.
  if (ops.length === 0 && !reboot) return;
  // Under the station-node lease: the firmware API server keeps one client, so an unserialized
  // write evicted the ingest RF receive stream and was evicted by its reconnect, mid-handshake.
  return withNodeLease("node-write", "config write", () => applyNodeConfigUnleased(host, port, ops, reboot));
}

async function applyNodeConfigUnleased(host: string, port: number, ops: NodeWriteOp[], reboot: boolean): Promise<void> {
  const m = await pb();

  await new Promise<void>((resolve, reject) => {
    let buf = new Uint8Array(0);
    let myNodeNum = 0;
    // The node's current sections, captured from the same want_config dump this connection already
    // drains, so a write needs no second connection and no client round-trip of secrets.
    const raws: RawSections = { config: new Map(), moduleConfig: new Map(), channels: new Map() };
    // config: draining the want_config dump; passkey: waiting for the get response; writing: sent.
    let phase: "config" | "passkey" | "writing" = "config";
    let settled = false;
    const socket = net.createConnection({ host, port });
    const done = (err?: Error) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(pkTimer); socket.destroy(); err ? reject(err) : resolve(); };
    const timer = setTimeout(() => {
      if (phase === "writing") return done();
      const missing = missingRaws(ops, raws);
      done(new Error(missing.length
        ? `timed out before the node reported its current ${missing.join(", ")}; nothing was written (writing without it would reset fields HopWatch does not model)`
        : "timed out before the node accepted the admin session"));
    }, 25000);
    let pkTimer: NodeJS.Timeout = setTimeout(() => {}, 0);

    const sendFrame = (admin: any, wantResponse = false) => socket.write(Buffer.from(frameAdmin(m, myNodeNum, admin, wantResponse)));

    // Ask the node for a session passkey (any get_*_response carries it). Fall back to writing with
    // no passkey if the node never answers (older firmware that neither issues nor requires one).
    const requestPasskey = () => {
      if (phase !== "config") return;
      phase = "passkey";
      try { sendFrame(mkAdmin(m, { case: "getDeviceMetadataRequest", value: true }, null), true); }
      catch (e) { return done(e as Error); }
      pkTimer = setTimeout(() => { if (phase === "passkey") writeAll(null); }, 4000);
    };

    const writeAll = (passkey: Uint8Array | null) => {
      if (phase === "writing") return;
      phase = "writing";
      clearTimeout(pkTimer);
      try {
        // Build every variant BEFORE sending anything: a missing raw section throws, and a partial
        // batch between begin_edit and commit_edit is worse than no write at all.
        const variants = buildWriteVariants(m, ops, raws);
        // A reboot-only request (no ops) skips the edit transaction entirely: reboot is a standalone
        // AdminMessage, and wrapping an empty begin/commit around it just risks a no-op edit.
        if (variants.length) {
          sendFrame(mkAdmin(m, { case: "beginEditSettings", value: true }, passkey));
          for (const variant of variants) sendFrame(mkAdmin(m, variant, passkey));
          sendFrame(mkAdmin(m, { case: "commitEditSettings", value: true }, passkey));
        }
        if (reboot) sendFrame(mkAdmin(m, { case: "rebootSeconds", value: 2 }, passkey));
      } catch (e) { return done(e as Error); }
      // Let the writes flush (and the node persist) before closing.
      setTimeout(() => done(), 1500);
    };

    socket.once("connect", async () => {
      try { socket.write(Buffer.from(await encodeWantConfig((randomBytes(4).readUInt32LE(0) >>> 0) || 1))); }
      catch (e) { done(e as Error); }
    });
    socket.on("error", (e) => done(new Error(`connect to ${host}:${port} failed: ${e.message}`)));
    // A close before the batch was written is a failure. Resolving there reported a successful
    // write for a node that had dropped the stream, so the UI said "Written" and re-read stale
    // values without any indication that nothing was applied.
    socket.on("close", () => done(phase === "writing" ? undefined
      : new Error(`node ${host}:${port} closed the stream before the changes were written`)));
    socket.on("data", async (chunk: Buffer) => {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0); merged.set(chunk, buf.length);
      const { frames, rest } = parseFrames(merged);
      buf = new Uint8Array(rest);
      for (const f of frames) {
        const msg = await decodeFromRadio(f).catch(() => null);
        if (!msg) continue;
        if (msg.kind === "config" && msg.raw !== undefined) raws.config.set(msg.section, msg.raw);
        else if (msg.kind === "moduleConfig" && msg.raw !== undefined) raws.moduleConfig.set(msg.section, msg.raw);
        else if (msg.kind === "channel" && msg.raw !== undefined) raws.channels.set(msg.index, msg.raw);
        if (msg.kind === "myInfo") {
          myNodeNum = msg.myNodeNum;
          // Fallback for firmware that never echoes config_complete_id: proceed once we have our
          // id, but only if the dump has already delivered every section the batch needs to
          // read-modify-write. Otherwise wait; the outer timer reports what was missing.
          setTimeout(() => { if (myNodeNum && missingRaws(ops, raws).length === 0) requestPasskey(); }, 3000);
        }
        // The node finished its dump: request the passkey (needs myNodeNum for the self-addressed admin frame).
        else if (msg.kind === "configComplete" && myNodeNum) requestPasskey();
        // Passkey arrived in the get response: write the batch stamped with it.
        else if (msg.kind === "adminResponse" && phase === "passkey") writeAll(msg.sessionPasskey);
      }
    });
  });
}

// -----------------------------------------------------------------------------
// NodeDB pruning: favorite repeaters/routers (so neither our prune nor the firmware's own eviction
// drops them) and remove stale nodes, to keep a RAM-constrained board from overfilling and
// reboot-looping. One connection does the want_config dump (which lists the NodeDB and yields the
// session passkey) and then the favorite/remove admin sends. Retries the flaky connect a few times.
// -----------------------------------------------------------------------------
export interface NodeDbPruneOpts {
  staleDays: number;
  favoriteRepeaters: boolean;
  repeaterNums?: number[]; // extra nums HopWatch classifies as infrastructure (node may label CLIENT)
  dryRun?: boolean;
}
export interface NodeDbPruneResult {
  total: number; favorited: number; removed: number; kept: number;
  favoritedNums: number[]; removedNums: number[]; hadPasskey: boolean; dryRun: boolean;
}

export async function pruneNodeDb(host: string, port: number, opts: NodeDbPruneOpts): Promise<NodeDbPruneResult> {
  if (!host) throw new Error("no node host configured for the station-node transport");
  return withNodeLease("node-write", "nodedb prune", async () => {
    const ATTEMPTS = 3;
    for (let i = 1; i <= ATTEMPTS; i++) {
      try { return await pruneNodeDbUnleased(host, port, opts); }
      catch (e) {
        if (i === ATTEMPTS) throw e;
        console.warn(`[nodedb] prune attempt ${i}/${ATTEMPTS} failed (${(e as Error).message}); retrying`);
        await sleep(600 * i);
      }
    }
    throw new Error("unreachable");
  });
}

async function pruneNodeDbUnleased(host: string, port: number, opts: NodeDbPruneOpts): Promise<NodeDbPruneResult> {
  const m = await pb();
  return await new Promise<NodeDbPruneResult>((resolve, reject) => {
    let buf = new Uint8Array(0);
    let myNodeNum = 0;
    const nodes: { num: number; role?: string; last_heard: number }[] = [];
    let phase: "config" | "passkey" | "acting" = "config";
    let settled = false;
    let result: NodeDbPruneResult | null = null;
    const socket = net.createConnection({ host, port });
    const done = (err?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(pkTimer); socket.destroy();
      if (err) return reject(err);
      resolve(result ?? { total: nodes.length, favorited: 0, removed: 0, kept: nodes.length, favoritedNums: [], removedNums: [], hadPasskey: false, dryRun: !!opts.dryRun });
    };
    const timer = setTimeout(() => {
      if (phase === "acting") return done();
      done(new Error(`node ${host}:${port} did not finish its NodeDB dump in time`));
    }, 25000);
    let pkTimer: NodeJS.Timeout = setTimeout(() => {}, 0);

    const sendFrame = (admin: any, wantResponse = false) => socket.write(Buffer.from(frameAdmin(m, myNodeNum, admin, wantResponse)));

    const requestPasskey = () => {
      if (phase !== "config") return;
      phase = "passkey";
      try { sendFrame(mkAdmin(m, { case: "getDeviceMetadataRequest", value: true }, null), true); }
      catch (e) { return done(e as Error); }
      pkTimer = setTimeout(() => { if (phase === "passkey") act(null); }, 4000);
    };

    const act = (passkey: Uint8Array | null) => {
      if (phase === "acting") return;
      phase = "acting";
      clearTimeout(pkTimer);
      try {
        const plan = planNodeDbPrune(nodes, myNodeNum, {
          staleDays: opts.staleDays, favoriteRepeaters: opts.favoriteRepeaters,
          repeaterNums: opts.repeaterNums, nowSec: Math.floor(Date.now() / 1000),
        });
        if (!opts.dryRun) {
          for (const num of plan.favorite) sendFrame(mkAdmin(m, { case: "setFavoriteNode", value: num >>> 0 }, passkey));
          for (const num of plan.remove) sendFrame(mkAdmin(m, { case: "removeByNodenum", value: num >>> 0 }, passkey));
        }
        result = {
          total: nodes.length, favorited: plan.favorite.length, removed: plan.remove.length, kept: plan.keep.length,
          favoritedNums: plan.favorite, removedNums: plan.remove, hadPasskey: passkey != null, dryRun: !!opts.dryRun,
        };
      } catch (e) { return done(e as Error); }
      // Let the admin frames flush before closing.
      setTimeout(() => done(), 1500);
    };

    socket.once("connect", async () => {
      try { socket.write(Buffer.from(await encodeWantConfig((randomBytes(4).readUInt32LE(0) >>> 0) || 1))); }
      catch (e) { done(e as Error); }
    });
    socket.on("error", (e) => done(new Error(`connect to ${host}:${port} failed: ${e.message}`)));
    socket.on("close", () => done(phase === "acting" ? undefined : new Error(`node ${host}:${port} closed the stream before pruning`)));
    socket.on("data", async (chunk: Buffer) => {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0); merged.set(chunk, buf.length);
      const { frames, rest } = parseFrames(merged);
      buf = new Uint8Array(rest);
      for (const f of frames) {
        const msg = await decodeFromRadio(f).catch(() => null);
        if (!msg) continue;
        if (msg.kind === "nodeInfo") nodes.push({ num: msg.num, role: msg.role, last_heard: msg.lastHeard });
        else if (msg.kind === "myInfo") {
          myNodeNum = msg.myNodeNum;
          setTimeout(() => { if (myNodeNum) requestPasskey(); }, 3000); // fallback if configComplete never comes
        } else if (msg.kind === "configComplete" && myNodeNum) requestPasskey();
        else if (msg.kind === "adminResponse" && phase === "passkey") act(msg.sessionPasskey);
      }
    });
  });
}
