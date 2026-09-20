import { query } from "../db/client.ts";
import { effectiveConfig } from "../db/appsettings.ts";
import { pruneNodeDb, type NodeDbPruneResult } from "../node/writeconfig.ts";
import { toMysqlUtc } from "../lib/time.ts";

// Periodic on-device NodeDB maintenance: favorite repeaters/routers and remove stale nodes so a
// RAM-constrained station node does not overfill and reboot-loop. Runs over the node admin API
// (like config writes), self-gated by node.nodedb_maint.interval_hours, last-run persisted in
// app_setting so it survives restarts.

const LAST_RUN_KEY = "nodedb_maint_last_run";
// HopWatch-side classification of infrastructure, to catch repeaters the node itself labels CLIENT.
const REPEATER_ROLES = ["ROUTER", "ROUTER_CLIENT", "REPEATER", "ROUTER_LATE"];

async function lastRunMs(): Promise<number> {
  const rows = await query<{ sval: string | null }>(`SELECT sval FROM app_setting WHERE skey=?`, [LAST_RUN_KEY]);
  const n = rows[0]?.sval ? Date.parse(rows[0]!.sval!) : NaN;
  return Number.isFinite(n) ? n : 0;
}

async function markRun(): Promise<void> {
  await query(
    `INSERT INTO app_setting (skey, sval, updated_at) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE sval=VALUES(sval), updated_at=VALUES(updated_at)`,
    [LAST_RUN_KEY, new Date().toISOString(), toMysqlUtc(new Date())],
  );
}

/** Node nums HopWatch classifies as infrastructure (repeater/router role, or acts as a relay). */
async function repeaterNums(): Promise<number[]> {
  const rows = await query<{ node_id: number }>(
    `SELECT node_id FROM nodes WHERE role IN (${REPEATER_ROLES.map(() => "?").join(",")}) OR is_relay=1`,
    REPEATER_ROLES,
  );
  return rows.map((r) => Number(r.node_id));
}

/**
 * Run NodeDB maintenance if enabled and the interval has elapsed (or force=true for the manual
 * button). Returns the prune result when it ran, or null when skipped. Records the run time even on
 * failure so a flaky node is not hammered every loop (pruneNodeDb already retries internally).
 */
export async function runNodeDbMaint(force = false): Promise<NodeDbPruneResult | null> {
  const cfg = await effectiveConfig();
  const nm = cfg.node.nodedb_maint;
  if (!cfg.node.host) { if (force) throw new Error("no station node configured"); return null; }
  if (!force && !nm.enabled) return null;
  if (!force) {
    if (Date.now() - (await lastRunMs()) < nm.interval_hours * 3600_000) return null;
  }
  try {
    const res = await pruneNodeDb(cfg.node.host, cfg.node.port, {
      staleDays: nm.stale_days,
      favoriteRepeaters: nm.favorite_repeaters,
      repeaterNums: await repeaterNums(),
    });
    console.log(`[nodedb] prune: ${res.total} in DB -> favorited ${res.favorited}, removed ${res.removed}, kept ${res.kept}`);
    await markRun();
    return res;
  } catch (e) {
    console.error(`[nodedb] prune failed: ${(e as Error).message}`);
    if (force) throw e;      // manual run: surface the error to the caller/UI
    await markRun();         // scheduled run: back off; a flaky node is expected, do not retry every loop
    return null;
  }
}
