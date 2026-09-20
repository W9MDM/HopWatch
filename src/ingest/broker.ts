import mqtt, { type MqttClient } from "mqtt";
import { readFileSync } from "node:fs";
import type { HopWatchConfig } from "../config/schema.ts";
import { effectiveTopicRoot } from "../meshtastic/topic.ts";

type BrokerCfg = HopWatchConfig["ingest"]["brokers"][number];

/** Latest $SYS/broker/# snapshot for this broker, or nulls if it does not expose $SYS to us. */
export interface BrokerSysStats {
  clientsConnected: number | null;
  clientsActive: number | null;
  clientsTotal: number | null;
  clientsDisconnected: number | null;
  uptimeS: number | null;
  version: string | null;
  msgsReceived: number | null;
  msgsSent: number | null;
  updatedAt: number | null;
}

export interface BrokerState {
  connected: boolean;
  lastMessageAt: number | null;
  messages: number;
  malformed: number;
  reconnects: number;
  sys: BrokerSysStats;
}

// The $SYS topics we track for broker presence. Kept to a fixed list rather than a `$SYS/broker/#`
// wildcard so we do not soak up every counter Mosquitto publishes. A broker that restricts $SYS
// simply never answers these subscriptions and the stats stay null.
const SYS_TOPICS = [
  "$SYS/broker/clients/connected", "$SYS/broker/clients/active", "$SYS/broker/clients/total",
  "$SYS/broker/clients/disconnected", "$SYS/broker/uptime", "$SYS/broker/version",
  "$SYS/broker/messages/received", "$SYS/broker/messages/sent",
];

// parseInt so "$SYS/broker/uptime" ("684145 seconds") yields the leading integer; NaN -> null.
function sysInt(v: string): number | null {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export type MessageHandler = (topic: string, payload: Buffer) => void | Promise<void>;

/** One MQTT connection per configured broker, with reconnect + health tracking. */
export class BrokerConnector {
  readonly state: BrokerState = {
    connected: false, lastMessageAt: null, messages: 0, malformed: 0, reconnects: 0,
    sys: { clientsConnected: null, clientsActive: null, clientsTotal: null, clientsDisconnected: null,
           uptimeS: null, version: null, msgsReceived: null, msgsSent: null, updatedAt: null },
  };
  private client: MqttClient | null = null;

  constructor(
    private cfg: BrokerCfg,
    private onMessage: MessageHandler,
  ) {}

  get id(): string {
    return this.cfg.id;
  }

  /** Path to this broker's Mosquitto log, if configured (for the connected-clients collector). */
  get logFile(): string {
    return this.cfg.log_file ?? "";
  }

  /** The broker's Meshtastic topic root (prefix before `/2/...`). Used to rewrite bridged
   * messages onto this broker's namespace so its subscribers actually receive them. Prefers
   * the admin-configured `root_topic`; otherwise derived from the first subscribe topic.
   * Empty if neither is available. */
  get topicRoot(): string {
    return effectiveTopicRoot(this.cfg.root_topic, this.cfg.topics).root;
  }

  start(): void {
    const scheme = this.cfg.tls.enabled ? "mqtts" : "mqtt";
    const url = `${scheme}://${this.cfg.host}:${this.cfg.port}`;
    this.client = mqtt.connect(url, {
      clientId: this.cfg.client_id || `hopwatch-${this.cfg.id}`,
      username: this.cfg.username || undefined,
      password: this.cfg.password || undefined,
      reconnectPeriod: 5000,
      ca: this.cfg.tls.enabled && this.cfg.tls.ca_file ? [readFileSync(this.cfg.tls.ca_file)] : undefined,
      cert: this.cfg.tls.enabled && this.cfg.tls.cert_file ? readFileSync(this.cfg.tls.cert_file) : undefined,
      key: this.cfg.tls.enabled && this.cfg.tls.key_file ? readFileSync(this.cfg.tls.key_file) : undefined,
      rejectUnauthorized: !this.cfg.tls.insecure_skip_verify,
    });

    this.client.on("connect", () => {
      this.state.connected = true;
      for (const topic of this.cfg.topics) {
        this.client!.subscribe(topic, { qos: this.cfg.qos }, (err) => {
          if (err) console.error(`[broker:${this.id}] subscribe ${topic} failed: ${err.message}`);
          else console.log(`[broker:${this.id}] subscribed ${topic}`);
        });
      }
      // Best-effort $SYS subscription for broker presence. Silent on failure: a broker that
      // restricts $SYS just never delivers these, which is not an error worth logging every connect.
      for (const topic of SYS_TOPICS) this.client!.subscribe(topic, { qos: 0 }, () => {});
    });

    this.client.on("message", (topic, payload) => {
      // $SYS is broker telemetry, not a mesh packet: feed the presence stats and skip the pipeline
      // and the message/lastMessage counters (those track ingested mesh traffic).
      if (topic.startsWith("$SYS/")) { this.updateSys(topic, payload); return; }
      this.state.messages++;
      this.state.lastMessageAt = Date.now();
      Promise.resolve(this.onMessage(topic, payload)).catch((e) =>
        console.error(`[broker:${this.id}] handler error: ${(e as Error).message}`),
      );
    });

    this.client.on("reconnect", () => {
      this.state.reconnects++;
      console.warn(`[broker:${this.id}] reconnecting…`);
    });
    this.client.on("close", () => {
      this.state.connected = false;
    });
    this.client.on("error", (e) => console.error(`[broker:${this.id}] error: ${e.message}`));
  }

  countMalformed(): void {
    this.state.malformed++;
  }

  /** Fold one $SYS/broker/... reading into the presence snapshot. */
  private updateSys(topic: string, payload: Buffer): void {
    const v = payload.toString("utf8").trim();
    const s = this.state.sys;
    switch (topic) {
      case "$SYS/broker/clients/connected": s.clientsConnected = sysInt(v); break;
      case "$SYS/broker/clients/active": s.clientsActive = sysInt(v); break;
      case "$SYS/broker/clients/total": s.clientsTotal = sysInt(v); break;
      case "$SYS/broker/clients/disconnected": s.clientsDisconnected = sysInt(v); break;
      case "$SYS/broker/uptime": s.uptimeS = sysInt(v); break;
      case "$SYS/broker/version": s.version = v.slice(0, 128); break;
      case "$SYS/broker/messages/received": s.msgsReceived = sysInt(v); break;
      case "$SYS/broker/messages/sent": s.msgsSent = sysInt(v); break;
      default: return;
    }
    s.updatedAt = Date.now();
  }

  /** Publish a raw payload (used by the MQTT text bridge). No-op if not connected. */
  publish(topic: string, payload: Buffer): void {
    if (this.client && this.state.connected) {
      this.client.publish(topic, payload, { qos: this.cfg.qos });
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.client) return resolve();
      this.client.end(false, {}, () => resolve());
    });
  }
}
