import { query } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { encryptSecret, decryptSecret } from "../lib/secrets.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// UI-managed ingest settings (brokers + channel keys). Seeded from config on first
// run, then edited via the admin API. The ingest daemon polls configFingerprint()
// and reloads when it changes.

export interface BrokerRow {
  id: string;
  enabled: number;
  host: string;
  port: number;
  username: string;
  password: string;
  client_id: string;
  tls_enabled: number;
  tls_insecure: number;
  qos: number;
  topics: string;
  root_topic: string;
  log_file: string;
  updated_at: string;
}

export type BrokerRuntime = HopWatchConfig["ingest"]["brokers"][number];

export async function seedIngestConfig(cfg: HopWatchConfig): Promise<void> {
  let seeded = false;
  const [b] = await query<{ c: number }>(`SELECT COUNT(*) c FROM mqtt_broker`);
  if (Number(b?.c ?? 0) === 0) {
    seeded = true;
    for (const br of cfg.ingest.brokers) {
      await query(
        `INSERT IGNORE INTO mqtt_broker
           (id, enabled, host, port, username, password, client_id, tls_enabled, tls_insecure, qos, topics, root_topic, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [br.id, 1, br.host, br.port, br.username, br.password, br.client_id || `hopwatch-${br.id}`,
         br.tls.enabled ? 1 : 0, br.tls.insecure_skip_verify ? 1 : 0, br.qos, JSON.stringify(br.topics), br.root_topic ?? "", toMysqlUtc(new Date())],
      );
    }
  }
  const [k] = await query<{ c: number }>(`SELECT COUNT(*) c FROM channel_key`);
  if (Number(k?.c ?? 0) === 0) {
    seeded = true;
    for (const ck of cfg.ingest.decode.channel_keys) {
      await query(`INSERT IGNORE INTO channel_key (name, key_b64, updated_at) VALUES (?,?,?)`, [ck.name, ck.key, toMysqlUtc(new Date())]);
    }
  }
  if (seeded) await bumpRev();
}

/** Advance the settings revision so the ingest daemon reloads on its next poll. */
export async function bumpRev(): Promise<void> {
  await query(`UPDATE settings_meta SET rev = rev + 1, updated_at = ? WHERE id = 1`, [toMysqlUtc(new Date())]);
}

export async function listBrokers(includeDisabled = true): Promise<BrokerRow[]> {
  return query<BrokerRow>(`SELECT * FROM mqtt_broker ${includeDisabled ? "" : "WHERE enabled=1"} ORDER BY id`);
}

export async function getRuntimeBrokers(): Promise<BrokerRuntime[]> {
  const rows = await listBrokers(false);
  return rows.map((r) => ({
    id: r.id,
    host: r.host,
    port: Number(r.port),
    username: r.username,
    password: decryptSecret(r.password, `broker "${r.id}" password`),
    client_id: r.client_id || `hopwatch-${r.id}`,
    tls: { enabled: !!r.tls_enabled, insecure_skip_verify: !!r.tls_insecure, ca_file: "", cert_file: "", key_file: "" },
    qos: (Number(r.qos) === 1 ? 1 : Number(r.qos) === 2 ? 2 : 0) as 0 | 1 | 2,
    topics: parseTopics(r.topics),
    root_topic: r.root_topic ?? "",
    log_file: r.log_file ?? "",
  }));
}

export async function getChannelKeys(): Promise<{ name: string; key: string }[]> {
  const rows = await query<{ name: string; key_b64: string }>(`SELECT name, key_b64 FROM channel_key ORDER BY name`);
  // Keys are encrypted at rest; decryptSecret passes through legacy plaintext values.
  return rows.map((r) => ({ name: r.name, key: decryptSecret(r.key_b64, `channel key "${r.name}"`) }));
}

/** Admin-safe channel-key listing: names + whether a key is set, never the PSK itself.
 * Rule 6: decrypted secrets are never returned to the client. */
export async function listChannelKeyMeta(): Promise<{ name: string; has_key: boolean }[]> {
  const rows = await query<{ name: string; key_b64: string }>(`SELECT name, key_b64 FROM channel_key ORDER BY name`);
  return rows.map((r) => ({ name: r.name, has_key: (r.key_b64 ?? "").length > 0 }));
}

/** Monotonic settings revision; ingest reloads when this advances. */
export async function configFingerprint(): Promise<number> {
  const [r] = await query<{ rev: number | null }>(`SELECT rev FROM settings_meta WHERE id=1`);
  return Number(r?.rev ?? 0);
}

export interface BrokerInput {
  id: string;
  enabled?: boolean;
  host: string;
  port: number;
  username?: string;
  password?: string;
  client_id?: string;
  tls_enabled?: boolean;
  tls_insecure?: boolean;
  qos?: number;
  topics: string[];
  root_topic?: string;
  log_file?: string;
}

export async function upsertBroker(b: BrokerInput): Promise<void> {
  await query(
    `INSERT INTO mqtt_broker
       (id, enabled, host, port, username, password, client_id, tls_enabled, tls_insecure, qos, topics, root_topic, log_file, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       enabled=VALUES(enabled), host=VALUES(host), port=VALUES(port), username=VALUES(username),
       password=VALUES(password), client_id=VALUES(client_id), tls_enabled=VALUES(tls_enabled),
       tls_insecure=VALUES(tls_insecure), qos=VALUES(qos), topics=VALUES(topics), root_topic=VALUES(root_topic),
       log_file=VALUES(log_file), updated_at=VALUES(updated_at)`,
    [
      b.id, b.enabled === false ? 0 : 1, b.host, b.port, b.username ?? "", encryptSecret(b.password ?? ""),
      b.client_id ?? `hopwatch-${b.id}`, b.tls_enabled ? 1 : 0, b.tls_insecure ? 1 : 0, b.qos ?? 0,
      JSON.stringify(b.topics), (b.root_topic ?? "").trim(), (b.log_file ?? "").trim(), toMysqlUtc(new Date()),
    ],
  );
  await bumpRev();
}

export async function deleteBroker(id: string): Promise<void> {
  await query(`DELETE FROM mqtt_broker WHERE id=?`, [id]);
  await bumpRev();
}

export async function upsertChannelKey(name: string, key: string): Promise<void> {
  await query(
    `INSERT INTO channel_key (name, key_b64, updated_at) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE key_b64=VALUES(key_b64), updated_at=VALUES(updated_at)`,
    [name, encryptSecret(key), toMysqlUtc(new Date())],
  );
  await bumpRev();
}

export async function deleteChannelKey(name: string): Promise<void> {
  await query(`DELETE FROM channel_key WHERE name=?`, [name]);
  await bumpRev();
}

// --- Notification forwarding rules (mesh -> Discord/Apprise) ---
export interface ForwardRule { id: string; enabled: boolean; events: string[]; channels: string[]; targets: string[] }

function jsonArr(s: string): string[] {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

export async function listForwardRules(onlyEnabled = false): Promise<ForwardRule[]> {
  const rows = await query<{ id: string; enabled: number; events: string; channels: string; targets: string }>(
    `SELECT id, enabled, events, channels, targets FROM forward_rule ${onlyEnabled ? "WHERE enabled=1" : ""} ORDER BY id`,
  );
  return rows.map((r) => ({
    id: r.id, enabled: !!r.enabled, events: jsonArr(r.events), channels: jsonArr(r.channels),
    targets: jsonArr(r.targets).map((t, i) => decryptSecret(t, `forward rule "${r.id}" target ${i + 1}`)).filter((t) => t !== ""),
  }));
}

/** Admin-safe forwarding listing: everything except the decrypted target URLs (which embed
 * webhook tokens). Rule 6: secrets are never returned to the client, only a count. */
export async function listForwardRuleMeta(): Promise<{ id: string; enabled: boolean; events: string[]; channels: string[]; target_count: number }[]> {
  const rows = await query<{ id: string; enabled: number; events: string; channels: string; targets: string }>(
    `SELECT id, enabled, events, channels, targets FROM forward_rule ORDER BY id`,
  );
  return rows.map((r) => ({
    id: r.id, enabled: !!r.enabled, events: jsonArr(r.events), channels: jsonArr(r.channels),
    target_count: jsonArr(r.targets).length,
  }));
}

/** Update a rule's metadata (events/channels/enabled) while retaining its stored encrypted
 * targets. Used when an admin edits a rule without re-entering the secret target URLs. */
export async function updateForwardRuleMeta(rule: { id: string; enabled: boolean; events: string[]; channels: string[] }): Promise<void> {
  await query(
    `UPDATE forward_rule SET enabled=?, events=?, channels=?, updated_at=? WHERE id=?`,
    [rule.enabled ? 1 : 0, JSON.stringify(rule.events), JSON.stringify(rule.channels), toMysqlUtc(new Date()), rule.id],
  );
}

export async function upsertForwardRule(rule: ForwardRule): Promise<void> {
  const enc = rule.targets.filter(Boolean).map((t) => encryptSecret(t));
  await query(
    `INSERT INTO forward_rule (id, enabled, events, channels, targets, updated_at) VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE enabled=VALUES(enabled), events=VALUES(events), channels=VALUES(channels),
       targets=VALUES(targets), updated_at=VALUES(updated_at)`,
    [rule.id, rule.enabled ? 1 : 0, JSON.stringify(rule.events), JSON.stringify(rule.channels), JSON.stringify(enc), toMysqlUtc(new Date())],
  );
}

export async function deleteForwardRule(id: string): Promise<void> {
  await query(`DELETE FROM forward_rule WHERE id=?`, [id]);
  await query(`DELETE FROM forward_state WHERE rule_id=?`, [id]);
}

/** Channel ids seen recently, for the forwarding UI channel picker. */
export async function distinctChannels(): Promise<string[]> {
  const rows = await query<{ channel_id: string }>(
    `SELECT DISTINCT channel_id FROM packets
     WHERE channel_id IS NOT NULL AND channel_id <> '' AND first_seen_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)
     LIMIT 50`,
  );
  return rows.map((r) => r.channel_id);
}

function parseTopics(t: string): string[] {
  try {
    const a = JSON.parse(t);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Service control: DB-mediated restart requests. The admin UI writes a restart
// timestamp; the target background process (worker/ingest) sees it on its next
// poll and exits, and systemd (Restart=always) brings it back. This keeps to the
// rule that processes only ever talk through the database, never direct IPC.
// ---------------------------------------------------------------------------

export async function requestServiceRestart(service: string, by: string | null): Promise<void> {
  await query(
    `INSERT INTO service_control (service, restart_at, requested_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE restart_at = VALUES(restart_at), requested_by = VALUES(requested_by)`,
    [service, toMysqlUtc(new Date()), by?.slice(0, 120) ?? null],
  );
}

/**
 * Ask the host's auto-update timer to update now (git pull, rebuild, restart all
 * services). The service='update' row is claimed and cleared by
 * scripts/linux-autoupdate.sh on its next tick (~1 min); without the
 * hopwatch-update.timer installed the request just sits unclaimed.
 */
export async function requestServiceUpdate(by: string | null): Promise<void> {
  await query(
    `INSERT INTO service_control (service, restart_at, requested_by) VALUES ('update', ?, ?)
     ON DUPLICATE KEY UPDATE restart_at = VALUES(restart_at), requested_by = VALUES(requested_by)`,
    [toMysqlUtc(new Date()), by?.slice(0, 120) ?? null],
  );
}

/** Epoch ms of the last restart request for a service, or 0 if none. */
export async function serviceRestartAtMs(service: string): Promise<number> {
  const rows = await query<{ restart_at: string }>(`SELECT restart_at FROM service_control WHERE service = ?`, [service]);
  return rows[0]?.restart_at ? new Date(rows[0].restart_at.replace(" ", "T") + "Z").getTime() : 0;
}

/**
 * The station-node "connect now" request.
 *
 * Web cannot reach the RX connector directly: it lives in the ingest process and processes share
 * state only through the database (Rule 5). So the button is a row, like the restart button, and
 * the connector picks it up on the lease poll it already runs every second. Reusing
 * `service_control` avoids a table for one timestamp; `service` is a free VARCHAR.
 */
export const NODE_RECONNECT_SERVICE = "node-reconnect";

export async function requestNodeReconnect(by: string | null): Promise<void> {
  await requestServiceRestart(NODE_RECONNECT_SERVICE, by);
}
