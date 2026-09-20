import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { getPool } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { parseMosquittoLog, connectedClients, classifyClient } from "../lib/mqttlog.ts";
import type { BrokerConnector } from "./broker.ts";

// Rebuild each broker's connected-client roster from its Mosquitto log and snapshot it into
// mqtt_client. Only brokers with a configured, readable log_file are processed (the local broker);
// everything else is left untouched. Runs on the ingest health tick.
//
// We read the most recent rotated file plus the current one so a client that connected before the
// midnight logrotate and never reconnected is still counted; in practice Meshtastic clients churn
// far more often than daily, so the current file alone is usually enough.

/** Turn a `!hhhhhhhh` node id into its numeric form, or null. */
function nodeNum(node: string | null): number | null {
  if (!node) return null;
  const n = parseInt(node.replace(/^!/, ""), 16);
  return Number.isFinite(n) ? n : null;
}

function readLog(path: string): string {
  let text = "";
  const gz = `${path}.1.gz`;
  try { if (existsSync(gz)) text += gunzipSync(readFileSync(gz)).toString("utf8"); } catch { /* skip rotated */ }
  try { if (existsSync(path)) text += `\n${readFileSync(path, "utf8")}`; } catch { /* skip current */ }
  return text;
}

export async function flushMqttClients(connectors: BrokerConnector[]): Promise<void> {
  const pool = getPool();
  const now = toMysqlUtc(new Date());
  for (const c of connectors) {
    const path = c.logFile;
    if (!path) continue;
    const text = readLog(path);
    if (!text) continue;
    const clients = connectedClients(parseMosquittoLog(text));

    // Replace this broker's snapshot atomically-ish: delete then insert the current set. The roster
    // is small (tens of rows), so a per-cycle rebuild is cheap and always consistent.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(`DELETE FROM mqtt_client WHERE broker_id=?`, [c.id]);
      for (const cl of clients) {
        const { kind, node } = classifyClient(cl.clientId);
        await conn.execute(
          `INSERT INTO mqtt_client (broker_id, client_id, ip, username, keepalive_s, protocol, kind,
             node_id, connected_at, last_event_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [c.id, cl.clientId.slice(0, 191), cl.ip, cl.username, cl.keepalive, cl.protocol, kind,
           nodeNum(node), toMysqlUtc(new Date(cl.connectedAt * 1000)),
           toMysqlUtc(new Date(cl.lastEventAt * 1000)), now],
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback().catch(() => {});
      console.error(`[ingest] mqtt_client flush failed for ${c.id}: ${(e as Error).message}`);
    } finally {
      conn.release();
    }
  }
}
