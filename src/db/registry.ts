import { randomUUID } from "node:crypto";
import { query } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";

// Instance registry storage (migration 0063). Two independent concerns:
//   - registry_self: THIS instance's own announcer identity (one row, id=1).
//   - registry_instance: heartbeats received while acting as a hub.

export interface RegistryInstance {
  instance_id: string;
  name: string;
  url: string;
  version: string;
  first_seen: string;
  last_seen: string;
  last_ip: string;
  hidden: number;
}

/** This instance's stable announcer id, created on first use. */
export async function getSelfId(): Promise<string> {
  const rows = await query<{ instance_id: string }>(`SELECT instance_id FROM registry_self WHERE id=1`);
  if (rows[0]?.instance_id) return rows[0].instance_id;
  const id = randomUUID();
  // INSERT IGNORE so two startup races do not both create a row; re-read the winner.
  await query(`INSERT IGNORE INTO registry_self (id, instance_id, last_announce_at) VALUES (1, ?, NULL)`, [id]);
  const again = await query<{ instance_id: string }>(`SELECT instance_id FROM registry_self WHERE id=1`);
  return again[0]?.instance_id ?? id;
}

/** When this instance last announced itself to a hub (null if never). */
export async function getLastAnnounce(): Promise<Date | null> {
  const rows = await query<{ last_announce_at: string | null }>(`SELECT last_announce_at FROM registry_self WHERE id=1`);
  const v = rows[0]?.last_announce_at;
  return v ? new Date(v.replace(" ", "T") + "Z") : null;
}

export async function setLastAnnounce(when: Date): Promise<void> {
  await query(`UPDATE registry_self SET last_announce_at=? WHERE id=1`, [toMysqlUtc(when)]);
}

/** Hub side: record (or refresh) a heartbeat from another instance. first_seen is preserved. */
export async function upsertInstance(i: { instance_id: string; name: string; url: string; version: string; ip: string }): Promise<void> {
  const now = toMysqlUtc(new Date());
  await query(
    `INSERT INTO registry_instance (instance_id, name, url, version, first_seen, last_seen, last_ip)
       VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE name=VALUES(name), url=VALUES(url), version=VALUES(version),
       last_seen=VALUES(last_seen), last_ip=VALUES(last_ip)`,
    [i.instance_id, i.name, i.url, i.version, now, now, i.ip],
  );
}

/** Hub side: all known instances, newest heartbeat first (admin directory, includes hidden). */
export async function listInstances(): Promise<RegistryInstance[]> {
  return query<RegistryInstance>(
    `SELECT instance_id, name, url, version, first_seen, last_seen, last_ip, hidden
       FROM registry_instance ORDER BY last_seen DESC`,
  );
}

/** Hub side: count of visible instances seen within the staleness window (dashboard tile). */
export async function countInstances(staleDays: number): Promise<number> {
  if (staleDays > 0) {
    const cutoff = toMysqlUtc(new Date(Date.now() - staleDays * 86400_000));
    const r = await query<{ c: number }>(
      `SELECT COUNT(*) c FROM registry_instance WHERE hidden=0 AND last_seen >= ?`, [cutoff]);
    return Number(r[0]?.c ?? 0);
  }
  const r = await query<{ c: number }>(`SELECT COUNT(*) c FROM registry_instance WHERE hidden=0`);
  return Number(r[0]?.c ?? 0);
}

export async function setInstanceHidden(id: string, hidden: boolean): Promise<void> {
  await query(`UPDATE registry_instance SET hidden=? WHERE instance_id=?`, [hidden ? 1 : 0, id]);
}

export async function deleteInstance(id: string): Promise<void> {
  await query(`DELETE FROM registry_instance WHERE instance_id=?`, [id]);
}
