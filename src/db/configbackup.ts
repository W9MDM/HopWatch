import { query, getPool } from "./client.ts";
import { bumpRev } from "./settings.ts";
import { toMysqlUtc } from "../lib/time.ts";

// Config backup/restore: serialize the admin-configured settings so an operator can save them and
// re-apply them on a fresh install or after a rebuild. Covers the UI-editable overrides plus the
// per-feature tables (brokers, channel keys, forward rules).
//
// Secrets (broker passwords, channel PSKs, forwarding targets) are exported as their AES-256-GCM
// CIPHERTEXT, never decrypted (Rule 6). A restore therefore only works on an install with the same
// HOPWATCH_MASTER_KEY; with a different key the encrypted values simply fail to decrypt later
// (non-fatal), exactly as if the secret were never entered. This is NOT operational data (packets,
// nodes, telemetry) -- only configuration.

export interface ConfigBackup {
  hopwatch_backup: { version: number; app_version: string; exported_at: string };
  config_overrides: unknown;
  brokers: Record<string, unknown>[];
  channel_keys: { name: string; key_b64: string }[];
  forward_rules: Record<string, unknown>[];
}

export async function exportConfig(appVersion: string, exportedAtIso: string): Promise<ConfigBackup> {
  const [ov] = await query<{ sval: string | null }>(`SELECT sval FROM app_setting WHERE skey='config_overrides'`);
  const brokers = await query<Record<string, unknown>>(
    `SELECT id, enabled, host, port, username, password, client_id, tls_enabled, tls_insecure, qos, topics, root_topic, log_file
     FROM mqtt_broker ORDER BY id`,
  );
  const channel_keys = await query<{ name: string; key_b64: string }>(`SELECT name, key_b64 FROM channel_key ORDER BY name`);
  const forward_rules = await query<Record<string, unknown>>(`SELECT id, enabled, events, channels, targets FROM forward_rule ORDER BY id`);
  return {
    hopwatch_backup: { version: 1, app_version: appVersion, exported_at: exportedAtIso },
    config_overrides: ov?.sval ? JSON.parse(ov.sval) : {},
    brokers, channel_keys, forward_rules,
  };
}

export interface ImportResult { overrides: boolean; brokers: number; channel_keys: number; forward_rules: number }

// mysql2 returns JSON columns already parsed; stringify for re-insert, pass through if already text.
function jsonCol(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? []);
}

/**
 * Replace the current configuration with a backup. Destructive: brokers, channel keys and forward
 * rules are cleared and re-inserted, and config_overrides is replaced wholesale (not merged). Runs
 * in a transaction, then bumps the settings revision so ingest/worker hot-reload.
 */
export async function importConfig(b: ConfigBackup): Promise<ImportResult> {
  if (!b || typeof b !== "object" || !b.hopwatch_backup || typeof b.hopwatch_backup.version !== "number") {
    throw new Error("not a HopWatch config backup (missing hopwatch_backup header)");
  }
  const now = () => toMysqlUtc(new Date());
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      `INSERT INTO app_setting (skey, sval, updated_at) VALUES ('config_overrides',?,?)
       ON DUPLICATE KEY UPDATE sval=VALUES(sval), updated_at=VALUES(updated_at)`,
      [JSON.stringify(b.config_overrides ?? {}), now()],
    );

    await conn.execute(`DELETE FROM mqtt_broker`);
    for (const r of b.brokers ?? []) {
      await conn.execute(
        `INSERT INTO mqtt_broker (id, enabled, host, port, username, password, client_id, tls_enabled, tls_insecure, qos, topics, root_topic, log_file, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [String(r.id), r.enabled ? 1 : 0, String(r.host ?? ""), Number(r.port) || 1883, String(r.username ?? ""),
         String(r.password ?? ""), String(r.client_id ?? ""), r.tls_enabled ? 1 : 0, r.tls_insecure ? 1 : 0,
         Number(r.qos) || 0, jsonCol(r.topics), String(r.root_topic ?? ""), String(r.log_file ?? ""), now()],
      );
    }

    await conn.execute(`DELETE FROM channel_key`);
    for (const k of b.channel_keys ?? []) {
      await conn.execute(`INSERT INTO channel_key (name, key_b64, updated_at) VALUES (?,?,?)`, [String(k.name), String(k.key_b64 ?? ""), now()]);
    }

    await conn.execute(`DELETE FROM forward_rule`);
    for (const f of b.forward_rules ?? []) {
      await conn.execute(
        `INSERT INTO forward_rule (id, enabled, events, channels, targets, updated_at) VALUES (?,?,?,?,?,?)`,
        [String(f.id), f.enabled ? 1 : 0, jsonCol(f.events), jsonCol(f.channels), jsonCol(f.targets), now()],
      );
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
  await bumpRev();
  return {
    overrides: true,
    brokers: (b.brokers ?? []).length,
    channel_keys: (b.channel_keys ?? []).length,
    forward_rules: (b.forward_rules ?? []).length,
  };
}
