// Daily partition management for the partitioned hot tables. The worker calls
// ensurePartitions() on a schedule to pre-create future daily partitions and
// dropExpiredPartitions() to enforce retention (fast metadata-only DROP PARTITION).
import { getPool } from "./client.ts";
import { addDays, floorDayUtc } from "../lib/time.ts";

export const PARTITIONED_TABLES = [
  "packets",
  "receptions",
  "packet_payloads",
  "node_telemetry",
  "reception_rollup_hour",
] as const;

export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];

function partName(day: Date): string {
  return "p" + day.toISOString().slice(0, 10).replace(/-/g, "");
}

interface PartRow { PARTITION_NAME: string | null }

async function existingPartitions(table: string): Promise<Set<string>> {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT PARTITION_NAME FROM information_schema.PARTITIONS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return new Set((rows as PartRow[]).map((r) => r.PARTITION_NAME).filter((n): n is string => !!n));
}

/**
 * Pre-create daily partitions from today through `aheadDays` in the future by
 * REORGANIZE-ing pmax. Idempotent: skips partitions that already exist.
 */
export async function ensurePartitions(table: PartitionedTable, aheadDays: number): Promise<number> {
  const pool = getPool();
  const existing = await existingPartitions(table);
  let created = 0;
  const start = floorDayUtc(new Date());
  for (let i = 0; i <= aheadDays; i++) {
    const day = addDays(start, i);
    const name = partName(day);
    if (existing.has(name)) continue;
    const boundary = addDays(day, 1).toISOString().slice(0, 10) + " 00:00:00";
    // Split pmax: [ ... , new daily VALUES LESS THAN (boundary), pmax MAXVALUE ]
    await pool.query(
      `ALTER TABLE \`${table}\` REORGANIZE PARTITION pmax INTO (
         PARTITION \`${name}\` VALUES LESS THAN ('${boundary}'),
         PARTITION pmax VALUES LESS THAN (MAXVALUE)
       )`,
    );
    created++;
  }
  return created;
}

/**
 * Drop daily partitions strictly older than `retainDays`. Returns dropped names.
 * pmin/pmax are never dropped.
 *
 * `holdBack` caps the cutoff: no partition on or after that day is dropped even if retention says
 * it has expired. Used to keep raw partitions the rollup fold has not consumed yet, since dropping
 * them destroys the only copy of data no aggregate has recorded.
 */
export async function dropExpiredPartitions(table: PartitionedTable, retainDays: number, holdBack?: Date | null): Promise<string[]> {
  const pool = getPool();
  const existing = await existingPartitions(table);
  let cutoff = floorDayUtc(addDays(new Date(), -retainDays));
  if (holdBack) {
    const limit = floorDayUtc(holdBack);
    if (limit < cutoff) cutoff = limit;
  }
  const dropped: string[] = [];
  for (const name of existing) {
    if (name === "pmin" || name === "pmax") continue;
    const m = /^p(\d{4})(\d{2})(\d{2})$/.exec(name);
    if (!m) continue;
    const day = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (day < cutoff) {
      await pool.query(`ALTER TABLE \`${table}\` DROP PARTITION \`${name}\``);
      dropped.push(name);
    }
  }
  return dropped;
}
