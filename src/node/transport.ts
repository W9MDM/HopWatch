import net from "node:net";
import { randomBytes } from "node:crypto";
import type { TxTransport } from "../tx/transport.ts";
import { effectiveConfig } from "../db/appsettings.ts";
import { encodeWantConfig } from "../meshtastic/encode.ts";
import { parseFrames } from "./frame.ts";
import { decodeFromRadio } from "../meshtastic/decode.ts";
import { txLog } from "../db/tx.ts";
import { withNodeLease } from "../db/nodelease.ts";

// Station-node transport: a direct TCP connection to a local Meshtastic node's stream API
// (default port 4403). publish() receives an already-framed ToRadio (see encodeToRadio) and hands
// it to the node, which does the RF send.
//
// Each publish opens a FRESH connection, runs the want_config handshake, waits until the node has
// reported its identity (the phone-API session is then live), writes the packet, and closes after
// a short flush. This mirrors the config-write path (which works reliably) rather than reusing a
// long-lived socket: firmware times out an idle stream (no heartbeat) and ignores packets injected
// before the session is initialized, which made a persistent socket silently drop sends.
//
// The whole publish runs under the station-node lease (src/db/nodelease.ts), because the firmware
// API server keeps one client and force-closes the previous one. Without it, connecting here
// evicted the ingest RX stream, whose immediate reconnect then evicted this handshake, and the two
// ping-ponged; the retry loop below existed to paper over exactly that.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NodeTxTransport implements TxTransport {
  async publish(_topic: string, bytes: Uint8Array): Promise<void> {
    const cfg = await effectiveConfig();
    const host = cfg.node.host;
    const port = cfg.node.port;
    if (!host) throw new Error("node.host is not configured for the station-node transport");

    // Each publish opens a FRESH TCP client, and a node on a marginal link (WiFi) is intermittently
    // unreachable at the instant of a cold connect (EHOSTUNREACH / ECONNRESET) even while ingest's
    // established RX socket rides straight through the same flap. The flaps are short, so we retry
    // the connect+handshake across a ~15s window (holding the lease) rather than failing the whole
    // row after a couple of quick tries: a good window almost always opens within that span, which
    // is what turned intermittent RF acks that never sent into ones that land. When the node is
    // genuinely down the row still fails and the outbox backs it off.
    const ATTEMPTS = 5;
    return withNodeLease("worker-tx", "RF publish", async () => {
      for (let i = 1; i <= ATTEMPTS; i++) {
        try {
          return await this.attempt(host, port, bytes);
        } catch (e) {
          const msg = (e as Error).message;
          if (i === ATTEMPTS) throw e;
          await txLog(`node connect attempt ${i}/${ATTEMPTS} failed (${msg}); retrying`, { level: "warn" });
          await sleep(1500 * i); // 1.5s, 3s, 4.5s, 6s -> ~15s of retries across the flap
        }
      }
    });
  }

  private async attempt(host: string, port: number, bytes: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let buf = new Uint8Array(0);
      let ready = false;
      let sent = false;
      // Set only once the kernel has accepted the ToRadio bytes. `sent` alone is not proof: it is
      // raised before the write, so a close between fire() and the write callback would otherwise
      // look like a successful transmit.
      let flushed = false;
      let settled = false;
      let sawIdentity = false;
      const socket = net.createConnection({ host, port });
      const done = (err?: Error) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); err ? reject(err) : resolve(); };
      const timer = setTimeout(() => done(flushed ? undefined
        : new Error(`node ${host}:${port} ${sawIdentity ? "never reached config_complete" : "did not answer want_config"} in time`)), 20_000);

      const fire = () => {
        if (sent) return;
        sent = true;
        void txLog(`session ready (config_complete); node publish -> ${host}:${port} (${bytes.length}B ToRadio; node does the RF send)`);
        socket.write(Buffer.from(bytes), (e) => {
          if (e) return done(e);
          flushed = true;
          // Give the node time to accept and transmit before we close the stream.
          setTimeout(() => done(), 1500);
        });
      };

      socket.once("connect", async () => {
        try { socket.write(Buffer.from(await encodeWantConfig((randomBytes(4).readUInt32LE(0) >>> 0) || 1))); }
        catch (e) { done(e as Error); }
      });
      socket.on("error", (e) => done(new Error(`connect to ${host}:${port} failed: ${e.message}`)));
      // A close before the frame was written is a FAILURE, not a success. It used to resolve, so a
      // node that accepted the TCP connection and then dropped the stream (its one-client eviction,
      // an idle timeout, a reboot) had the outbox row recorded as `sent` with nothing transmitted:
      // a phantom transmit in the audit log, which Rule 2 cannot tolerate. Now it fails and retries.
      socket.on("close", () => done(flushed ? undefined
        : new Error(`node ${host}:${port} closed the stream before the ToRadio frame was written`)));
      socket.on("data", async (chunk: Buffer) => {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf, 0); merged.set(chunk, buf.length);
        const { frames, rest } = parseFrames(merged);
        buf = new Uint8Array(rest);
        if (ready) return;
        for (const f of frames) {
          const msg = await decodeFromRadio(f).catch(() => null);
          if (!msg) continue;
          if (msg.kind === "myInfo") sawIdentity = true;
          // Only originate AFTER the node finishes its config dump. Injecting during the dump
          // (on myInfo, the first frame) is silently dropped: the node is not yet ready to TX.
          if (msg.kind === "configComplete") { ready = true; fire(); break; }
        }
      });
    });
  }

  async close(): Promise<void> { /* no persistent socket to close */ }
}
