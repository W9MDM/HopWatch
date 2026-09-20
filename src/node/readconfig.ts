import net from "node:net";
import { randomBytes } from "node:crypto";
import { parseFrames } from "./frame.ts";
import { encodeWantConfig } from "../meshtastic/encode.ts";
import { decodeFromRadio, type FromRadioMsg } from "../meshtastic/decode.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { channelWireName } from "../meshtastic/channelname.ts";
import { withNodeLease } from "../db/nodelease.ts";

// Read a station node's full configuration over the Meshtastic stream API (default TCP
// 4403), the same thing MeshMonitor does over the device HTTP API: send want_config_id and
// collect the FromRadio dump (metadata, config, module config, channels, node DB) until the
// node echoes config_complete_id. Read-only: this never transmits over RF, so it is not
// gated by the TX arm/rails. Runs in the web process as a device query (not inter-process).

// `psk` (base64) is populated only when readNodeConfig is called with { includePsk } from a
// server-side write path so a channel's key can be round-tripped unchanged; the public
// /admin/node/config route never sets that flag, so the key never reaches the browser (Rule 6).
// `name` is the channel's WIRE name: its own settings.name, or (when that is empty, as it is on a
// default primary channel) the modem-preset substitution Channels::getName applies. It is a wire
// identity, not a caption: it is xor-folded into the channel hash and published as
// ServiceEnvelope.channel_id, and src/worker/tx.ts keys its channel-index lookup on it. `label` is
// the separate display string, so a placeholder can never leak into the identity.
export interface NodeChannel { index: number; role: string; name: string; label: string; encrypted: boolean; uplink: boolean; downlink: boolean; psk?: string; position_precision?: number }
export interface NodeDbEntry { num: number; node_id: string; long_name?: string; short_name?: string; hw_model?: string; role?: string; last_heard: number }

export interface NodeConfigSnapshot {
  host: string;
  port: number;
  my_node_num: number | null;
  my_node_id: string | null;
  metadata: { firmware_version: string; hw_model?: string; role?: string; has_wifi: boolean; has_bluetooth: boolean } | null;
  config: Record<string, Record<string, unknown>>;        // section -> scalar values
  module_config: Record<string, Record<string, unknown>>; // section -> scalar values
  channels: NodeChannel[];
  nodes: NodeDbEntry[];
  complete: boolean;
}

const CHANNEL_ROLE = ["disabled", "primary", "secondary"];

/**
 * Connect, request config, and return a normalized snapshot. Rejects on connect/timeout.
 *
 * Runs under the station-node lease: the firmware API server keeps one client and force-closes the
 * previous one, so an unserialized read here evicted the ingest RF receive stream (and got evicted
 * by its reconnect). See src/db/nodelease.ts.
 */
export async function readNodeConfig(host: string, port = 4403, timeoutMs = 15000, opts: { includePsk?: boolean } = {}): Promise<NodeConfigSnapshot> {
  if (!host) throw new Error("no node host configured");
  return withNodeLease("node-read", "config read", () => readNodeConfigUnleased(host, port, timeoutMs, opts));
}

async function readNodeConfigUnleased(host: string, port: number, timeoutMs: number, opts: { includePsk?: boolean }): Promise<NodeConfigSnapshot> {
  const nonce = randomBytes(4).readUInt32LE(0) >>> 0 || 1;
  const snap: NodeConfigSnapshot = {
    host, port, my_node_num: null, my_node_id: null, metadata: null,
    config: {}, module_config: {}, channels: [], nodes: [], complete: false,
  };

  await new Promise<void>((resolve, reject) => {
    let buf = new Uint8Array(0);
    let settled = false;
    const socket = net.createConnection({ host, port });
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => done(snap.complete ? undefined : new Error(`timed out after ${timeoutMs}ms (node did not finish its config dump)`)), timeoutMs);

    socket.once("connect", async () => {
      try {
        socket.write(Buffer.from(await encodeWantConfig(nonce)));
      } catch (e) {
        done(e as Error);
      }
    });
    socket.on("error", (e) => done(new Error(`connect to ${host}:${port} failed: ${e.message}`)));
    // A close before config_complete is a failure: resolving there returned a PARTIAL snapshot that
    // looked like a real one, so a caller could act on a config it never fully read (and the
    // worker's channel-index cache could be built from a half dump).
    socket.on("close", () => done(snap.complete ? undefined
      : new Error(`node ${host}:${port} closed the stream before finishing its config dump`)));
    socket.on("data", async (chunk: Buffer) => {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0); merged.set(chunk, buf.length);
      const { frames, rest } = parseFrames(merged);
      buf = new Uint8Array(rest); // copy remainder into a fresh ArrayBuffer-backed view
      for (const f of frames) {
        const msg = await decodeFromRadio(f);
        if (msg) apply(snap, msg, !!opts.includePsk);
        if (snap.complete) { done(); return; }
      }
    });
  });

  snap.nodes.sort((a, b) => b.last_heard - a.last_heard);
  resolveChannelNames(snap);
  return snap;
}

function apply(snap: NodeConfigSnapshot, msg: FromRadioMsg, includePsk = false): void {
  switch (msg.kind) {
    case "myInfo":
      snap.my_node_num = msg.myNodeNum;
      snap.my_node_id = formatNodeId(msg.myNodeNum);
      break;
    case "metadata":
      snap.metadata = { firmware_version: msg.firmwareVersion, hw_model: msg.hwModel, role: msg.role, has_wifi: msg.hasWifi, has_bluetooth: msg.hasBluetooth };
      break;
    case "config":
      snap.config[msg.section] = msg.values;
      break;
    case "moduleConfig":
      snap.module_config[msg.section] = msg.values;
      break;
    case "channel":
      // Left as the raw (possibly empty) name here; resolveChannelNames fills it in once the dump
      // has also delivered config.lora, which is what the substitution depends on.
      if (msg.role !== 0) snap.channels.push({ index: msg.index, role: CHANNEL_ROLE[msg.role] ?? String(msg.role), name: msg.name, label: msg.name, encrypted: msg.hasPsk, uplink: msg.uplink, downlink: msg.downlink, ...(includePsk ? { psk: msg.psk, position_precision: msg.positionPrecision } : {}) });
      break;
    case "nodeInfo":
      snap.nodes.push({ num: msg.num, node_id: formatNodeId(msg.num), long_name: msg.longName, short_name: msg.shortName, hw_model: msg.hwModel, role: msg.role, last_heard: msg.lastHeard });
      break;
    case "configComplete":
      snap.complete = true;
      break;
  }
}

/**
 * Fill in the wire name of any channel whose settings.name is empty, the way the firmware does:
 * Channels::getName substitutes the modem preset's display name (or "Custom" when use_preset is
 * off). Writing our own placeholder into `name` instead named a channel that does not exist, so its
 * hash and its channel_id both differed from the mesh's, and the TX channel-index lookup missed.
 * The display caption keeps a hint that the name is inherited rather than set on the channel.
 */
function resolveChannelNames(snap: NodeConfigSnapshot): void {
  const lora = snap.config.lora ?? {};
  const preset = lora.modem_preset === undefined ? undefined : String(lora.modem_preset);
  const usePreset = lora.use_preset !== false;
  for (const c of snap.channels) {
    if (c.name) { c.label = c.name; continue; }
    c.name = channelWireName("", preset, usePreset);
    c.label = `${c.name} (from preset)`;
  }
}
