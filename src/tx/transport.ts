import mqtt, { type MqttClient } from "mqtt";
import { randomBytes } from "node:crypto";
import { getRuntimeBrokers } from "../db/settings.ts";
import { effectiveConfig } from "../db/appsettings.ts";
import { txLog } from "../db/tx.ts";

// Throttle the per-broker "connecting" line so a broker outage (a connect attempt every tick) does
// not flood tx_log / stdout. Once per broker per 60s.
const lastConnectLog = new Map<string, number>();

// A TX backend. Phase 1 ships the MQTT downlink; phase 2 adds a station-node transport.
// The outbox worker is the only caller.
export interface TxTransport {
  publish(topic: string, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** Publishes protobuf ServiceEnvelopes to a broker downlink topic. Lazily connects. */
export class MqttTxTransport implements TxTransport {
  private client: MqttClient | null = null;
  private connectedBrokerId: string | null = null;
  /**
   * Per-instance clientId discriminator. MQTT brokers enforce clientId uniqueness by DISCONNECTING
   * the older session, and the worker can hold two transports pointed at one broker at the same
   * time: the shared transport (tx.broker_id) plus a pinned one from mqttFor() for a row whose
   * broker_id names that same broker. With a clientId of just `hopwatch-tx-<brokerId>` they evicted
   * each other in a loop, dropping publishes mid-flight. Generated once per instance so it stays
   * stable across that instance reconnects.
   */
  private readonly tag = `${randomBytes(3).toString("hex")}`;
  constructor(private brokerId?: string) {}

  private async ensure(): Promise<MqttClient> {
    // Broker choice: constructor override, else tx.broker_id (hot-reloadable), else first enabled.
    const cfg = await effectiveConfig();
    const desired = this.brokerId || cfg.tx.broker_id || null;
    // Reuse the live connection only if it points at the still-desired broker.
    if (this.client?.connected && this.connectedBrokerId === (desired ?? "*")) return this.client;
    if (this.client) await this.close(); // broker changed under us: drop and reconnect
    const brokers = await getRuntimeBrokers();
    const b = desired ? brokers.find((x) => x.id === desired) : brokers[0];
    if (!b) throw new Error(desired ? `TX broker "${desired}" not found or not enabled` : "no enabled broker available for TX");
    const scheme = b.tls.enabled ? "mqtts" : "mqtt";
    const nowMs = Date.now();
    if ((lastConnectLog.get(b.id) ?? 0) < nowMs - 60_000) {
      lastConnectLog.set(b.id, nowMs);
      await txLog(`mqtt transport connecting to broker "${b.id}" ${scheme}://${b.host}:${b.port}${desired ? "" : " (first enabled; set a TX broker to choose)"}`);
    }
    const client = mqtt.connect(`${scheme}://${b.host}:${b.port}`, {
      clientId: `hopwatch-tx-${b.id}-${this.brokerId ? "pin" : "def"}-${this.tag}`,
      username: b.username || undefined,
      password: b.password || undefined,
      reconnectPeriod: 5000,
      rejectUnauthorized: !b.tls.insecure_skip_verify,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("mqtt connect timeout")), 10_000);
        client.once("connect", () => { clearTimeout(t); resolve(); });
        client.once("error", (e) => { clearTimeout(t); reject(e); });
      });
    } catch (e) {
      // Force-close so the failed client's 5s auto-reconnect loop does not leak forever; without
      // this, every publish attempt during a broker outage spawns another orphaned reconnecting
      // client (unbounded socket/timer growth).
      client.end(true);
      throw e;
    }
    // Only now do we own a live connection; record identity after connect, not before.
    this.client = client;
    this.connectedBrokerId = desired ?? "*";
    return client;
  }

  async publish(topic: string, bytes: Uint8Array): Promise<void> {
    const client = await this.ensure();
    await txLog(`mqtt publish -> broker "${this.connectedBrokerId}" topic="${topic}" (${bytes.length}B)`);
    await new Promise<void>((resolve, reject) => {
      client.publish(topic, Buffer.from(bytes), { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.client) return resolve();
      this.client.end(false, {}, () => resolve());
    });
    this.client = null;
  }
}
