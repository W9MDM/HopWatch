import net from "node:net";
import { randomBytes } from "node:crypto";
import { parseFrames } from "../node/frame.ts";
import { encodeWantConfig, encodeHeartbeat } from "../meshtastic/encode.ts";
import { decodeNodeFrame, type ChannelKey, type NodeChannelNames } from "../meshtastic/decode.ts";
import { channelWireName } from "../meshtastic/channelname.ts";
import { recordAdminOk } from "../db/adminscan.ts";
import { nodeLeaseHolder } from "../db/nodelease.ts";
import { serviceRestartAtMs, NODE_RECONNECT_SERVICE } from "../db/settings.ts";
import type { NormalizedEnvelope } from "../meshtastic/types.ts";

export type NodeRxHandler = (env: NormalizedEnvelope) => void | Promise<void>;

export interface NodeRxState {
  connected: boolean;
  myNodeNum: number;
  packets: number;
  lastPacketAt: number | null;
  reconnects: number;
  /** Last time ANY frame arrived (packets, queue_status heartbeat replies, config dump). Liveness,
   * unlike lastPacketAt, which stays null on a quiet mesh. */
  lastDataAt: number | null;
  /** Standing down because another process holds the station-node lease. Not a fault. */
  yielded: boolean;
  yieldedTo: string | null;
}

/** Keepalive cadence. Well inside the firmware's 15-minute TCP_IDLE_TIMEOUT_MS, and each one draws
 * a queue_status reply, which doubles as our liveness probe. */
const HEARTBEAT_MS = 120_000;
/** No frame at all for this long means the link is dead even though the socket still looks open
 * (power loss, AP change, NAT eviction: no FIN ever arrives). Three heartbeat round-trips. */
const WATCHDOG_MS = 420_000;
/** How often to check whether another process wants the node. Must be under the lease handoff
 * grace period in src/db/nodelease.ts, or a holder connects before we have let go. */
const LEASE_POLL_MS = 1_000;
/** Reconnect delay once a lease clears. Short: the node is known to be free. */
const RESUME_MS = 250;

// Persistent TCP connection to a station node's stream API (default 4403) that ingests its own
// RF receptions as a first-class source. Sends want_config to open the FromRadio stream, learns
// the node's id from myInfo, then feeds each received MeshPacket to the handler (tagged
// transport=rf upstream). Reconnects with exponential backoff. Read-only: it never transmits (the
// heartbeat is a client keepalive the node answers off-air, see encodeHeartbeat).
//
// The firmware API server keeps ONE client and force-closes the previous one, so this connector
// yields: while another process holds the station-node lease (a TX publish, an admin config
// read/write), it closes its socket and does NOT reconnect. Without that it fought them, since a
// successful connect resets the backoff to 1s: a TX publish evicted this stream, this stream's
// reconnect evicted the TX handshake, and the retry evicted this stream again.
export class NodeRxConnector {
  readonly state: NodeRxState = {
    connected: false, myNodeNum: 0, packets: 0, lastPacketAt: null, reconnects: 0,
    lastDataAt: null, yielded: false, yieldedTo: null,
  };
  private socket: net.Socket | null = null;
  private buf = new Uint8Array(0);
  private stopped = false;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  // The node's own channel table, learned from the want_config dump this connection already asks
  // for. A packet the node decrypted arrives with MeshPacket.channel rewritten to the local channel
  // INDEX, so without this table an RF reception has no channel identity at all. Raw names are kept
  // as sent and resolved through channelWireName, because an empty name is not nameless upstream:
  // Channels::getName substitutes the modem preset's display name, and THAT is the string the mesh
  // and the MQTT topic use.
  private rawChannelNames = new Map<number, string>();
  private channelNames: NodeChannelNames = new Map();
  private modemPreset: string | undefined;
  private usePreset = true;
  /** Newest "connect now" request already acted on, so one click reconnects once. */
  private lastKickMs = Date.now();

  constructor(
    readonly host: string,
    readonly port: number,
    private getKeys: () => ChannelKey[],
    private onPacket: NodeRxHandler,
  ) {}

  get id(): string { return "node"; }

  /** True when the stream is up AND has produced a frame recently. `connected` alone lied: a node
   * that vanished without a FIN left it true forever while nothing was being ingested. */
  get healthy(): boolean {
    if (!this.state.connected) return false;
    return this.state.lastDataAt === null || Date.now() - this.state.lastDataAt < WATCHDOG_MS;
  }

  start(): void {
    this.stopped = false;
    this.leaseTimer = setInterval(() => void this.checkLease(), LEASE_POLL_MS);
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.leaseTimer) { clearInterval(this.leaseTimer); this.leaseTimer = null; }
    this.clearSocketTimers();
    if (this.socket) { this.socket.destroy(); this.socket = null; }
    this.state.connected = false;
  }

  private clearSocketTimers(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.watchdogTimer) { clearTimeout(this.watchdogTimer); this.watchdogTimer = null; }
  }

  /**
   * Reconnect now, abandoning any backoff the connector is sitting in.
   *
   * Called by the admin "Connect now" button and used internally when the node is known to be free.
   * A node that was off for a while leaves the connector waiting out its 30s ceiling, and an
   * operator who has just power-cycled it should not have to wait for that or restart the daemon.
   */
  reconnectNow(reason: string): void {
    if (this.stopped || this.state.yielded) return;
    console.log(`[node-rx] reconnecting now (${reason})`);
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.backoff = 1000; // a manual attempt starts the ladder over, it does not inherit the wait
    if (this.socket) { this.clearSocketTimers(); this.socket.destroy(); this.socket = null; }
    this.state.connected = false;
    this.connect();
  }

  /** Stand down while another process holds the node, and come back promptly when it lets go. */
  private async checkLease(): Promise<void> {
    if (this.stopped) return;
    // Piggybacked on the lease poll rather than given a timer of its own: this already runs every
    // second, so a click lands within ~1s at no extra cost.
    try {
      const kickAt = await serviceRestartAtMs(NODE_RECONNECT_SERVICE);
      if (kickAt > this.lastKickMs) {
        this.lastKickMs = kickAt;
        // Deliberately after the lease check below would run: if another process holds the node,
        // reconnectNow() no-ops and checkLease resumes us the moment the lease clears anyway.
        if (!this.state.yielded) this.reconnectNow("requested from /admin");
      }
    } catch { /* transient DB error: the next tick retries */ }
    const held = await nodeLeaseHolder();
    if (held) {
      if (!this.state.yielded) {
        this.state.yielded = true;
        this.state.yieldedTo = `${held.holder}: ${held.reason}`;
        console.log(`[node-rx] yielding the station node to ${this.state.yieldedTo}`);
      }
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      if (this.socket) { this.clearSocketTimers(); this.socket.destroy(); this.socket = null; }
      this.state.connected = false;
      return;
    }
    if (this.state.yielded) {
      this.state.yielded = false;
      this.state.yieldedTo = null;
      // The node is known free, so do not serve out an exponential backoff before returning.
      this.backoff = RESUME_MS;
      if (!this.socket && !this.reconnectTimer) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.state.yielded) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  /** Restart the receive watchdog. Called on connect and on every inbound frame. */
  private armWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      console.error(`[node-rx] no data from ${this.host}:${this.port} in ${Math.round(WATCHDOG_MS / 1000)}s; dropping the dead socket`);
      this.socket?.destroy(); // the close handler drives the reconnect
    }, WATCHDOG_MS);
  }

  /** Recompute index -> wire name after either the channel table or the modem preset changes. */
  private resolveChannelNames(): void {
    this.channelNames = new Map(
      [...this.rawChannelNames].map(([i, raw]) => [i, channelWireName(raw, this.modemPreset, this.usePreset)]),
    );
  }

  private connect(): void {
    if (this.stopped || this.state.yielded) return;
    this.buf = new Uint8Array(0);
    // The dump re-sends the whole table on every connect; drop the old one so a channel removed on
    // the device does not linger and name a packet after a channel that no longer exists.
    this.rawChannelNames.clear();
    this.channelNames = new Map();
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    // OS-level probes catch a peer that is gone but whose socket is still open locally. The
    // application watchdog below is the backstop, since keepalive alone can take minutes.
    socket.setKeepAlive(true, 30_000);
    socket.once("connect", async () => {
      this.state.connected = true;
      this.backoff = 1000;
      this.armWatchdog();
      try {
        const nonce = randomBytes(4).readUInt32LE(0) >>> 0 || 1;
        socket.write(Buffer.from(await encodeWantConfig(nonce))); // opens the FromRadio stream
      } catch { /* handled by error/close -> reconnect */ }
      // Keep the session alive: the node drops a client that has said nothing for 15 minutes, and
      // only client-to-node traffic counts. Each beat also draws a queue_status reply, so a link
      // that has silently died stops feeding the watchdog.
      this.heartbeatTimer = setInterval(() => {
        void (async () => {
          try { socket.write(Buffer.from(await encodeHeartbeat())); }
          catch { /* a dead socket raises error/close, which reconnects */ }
        })();
      }, HEARTBEAT_MS);
    });
    socket.on("data", (chunk: Buffer) => void this.onData(chunk));
    socket.on("error", () => { this.state.connected = false; });
    socket.on("close", () => {
      this.state.connected = false;
      this.clearSocketTimers();
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      // A close because we handed the node to another process is not a fault, so it must not inflate
      // the reconnect counter the health page reads (or trigger a reconnect: checkLease resumes us).
      if (this.state.yielded) return;
      this.state.reconnects++;
      this.scheduleReconnect();
    });
  }

  private async onData(chunk: Buffer): Promise<void> {
    this.state.lastDataAt = Date.now();
    this.armWatchdog();
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0); merged.set(chunk, this.buf.length);
    const { frames, rest } = parseFrames(merged);
    this.buf = new Uint8Array(rest);
    const keys = this.getKeys();
    for (const f of frames) {
      let frame;
      try { frame = await decodeNodeFrame(f, keys, this.state.myNodeNum, this.channelNames); } catch { continue; }
      if (!frame) continue;
      if (frame.kind === "myInfo") { this.state.myNodeNum = frame.myNodeNum; continue; }
      if (frame.kind === "channel") {
        // role 0 is DISABLED: no traffic can arrive on it, and keeping it would map an index to a
        // channel the node is not actually a member of.
        if (frame.role === 0) this.rawChannelNames.delete(frame.index);
        else this.rawChannelNames.set(frame.index, frame.name);
        this.resolveChannelNames();
        continue;
      }
      if (frame.kind === "modemPreset") {
        this.modemPreset = frame.preset;
        this.usePreset = frame.usePreset;
        this.resolveChannelNames();
        continue;
      }
      // Remote-admin scanner: a node answered our DeviceMetadata request -> it is administrable.
      if (frame.kind === "adminMetadata") {
        try { await recordAdminOk(frame.from, { firmware: frame.firmwareVersion, hwModel: frame.hwModel, role: frame.role }); }
        catch (e) { console.error(`[node-rx] admin record failed: ${(e as Error).message}`); }
        continue;
      }
      // Only ingest once we know our node id, so the RF reception is attributed to this gateway.
      if (this.state.myNodeNum === 0) continue;
      this.state.packets++;
      this.state.lastPacketAt = Date.now();
      try { await this.onPacket(frame.env); } catch (e) { console.error(`[node-rx] handler failed: ${(e as Error).message}`); }
    }
  }
}
