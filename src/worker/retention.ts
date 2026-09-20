// Retention + partition management (spec §3). Runs periodically from the worker.
import { getPool } from "../db/client.ts";
import { effectiveConfig } from "../db/appsettings.ts";
import { ensurePartitions, dropExpiredPartitions } from "../db/partitions.ts";
import { getWatermark } from "./rollups.ts";
import { floorDayUtc } from "../lib/time.ts";

/**
 * Run one retention duty, logging and swallowing its failure.
 *
 * Every step used to share one unguarded path, so a single ALTER failure (the DB user lacking
 * ALTER, a REORGANIZE hitting a lock timeout, a table manually altered out of its pmax partition)
 * rejected the whole function. Everything after it was skipped, including the live_events DELETE,
 * and live_events is written on every ingested reception and trimmed ONLY here: it then grew at full
 * ingest rate until the disk filled, with one "retention failed" line every 30 minutes as the sole
 * symptom. Each duty is now independent.
 */
async function duty<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[worker] retention ${label} failed: ${(e as Error).message}`);
    return null;
  }
}

export async function runRetention(): Promise<void> {
  // effectiveConfig (not loadConfig) so retention windows set in /admin actually take effect.
  const cfg = await effectiveConfig();
  const ahead = cfg.database.partitioning.precreate_ahead_days;

  // 1. Pre-create upcoming daily partitions on every partitioned table.
  for (const t of ["packets", "receptions", "packet_payloads", "node_telemetry", "reception_rollup_hour"] as const) {
    await duty(`ensurePartitions(${t})`, () => ensurePartitions(t, ahead));
  }

  // 2. Drop expired partitions per the configured retention windows.
  //
  //    The raw tables the rollups are built from are held back to the fold watermark. Dropping a
  //    partition the hourly fold has not consumed destroys the only copy of data no aggregate ever
  //    recorded, and the fold would then walk forward over hours whose rows no longer exist. This
  //    matters because retention also runs at worker startup, BEFORE the first fold, and because a
  //    fold that throws is swallowed by the caller's safe() wrapper, so the watermark can sit still
  //    for days without anything failing loudly.
  const foldedThrough = await duty("read fold watermark", () => getWatermark("hourly"));
  const holdBack = foldedThrough ? floorDayUtc(foldedThrough) : new Date(0);
  if (!foldedThrough) {
    console.log("[worker] retention: no hourly rollup watermark yet, holding back raw partition drops");
  }
  const dp = (await duty("drop packets", () => dropExpiredPartitions("packets", cfg.retention.decoded_packet_days, holdBack))) ?? [];
  const dr = (await duty("drop receptions", () => dropExpiredPartitions("receptions", cfg.retention.decoded_packet_days, holdBack))) ?? [];
  const dpp = (await duty("drop packet_payloads", () => dropExpiredPartitions("packet_payloads", cfg.retention.raw_payload_days, holdBack))) ?? [];
  const dt = (await duty("drop node_telemetry", () => dropExpiredPartitions("node_telemetry", cfg.retention.telemetry_days))) ?? [];
  const drh = (await duty("drop reception_rollup_hour", () => dropExpiredPartitions("reception_rollup_hour", cfg.retention.reception_rollup_hour_days))) ?? [];
  const dropped = [...dp, ...dr, ...dpp, ...dt, ...drh];
  if (dropped.length) console.log(`[worker] dropped ${dropped.length} expired partition(s)`);
  // A watermark far behind the retention window means the fold is stuck and raw data is piling up
  // instead of expiring. Say so: the alternative was silent unbounded growth or silent data loss.
  const rawCutoffDays = cfg.retention.decoded_packet_days;
  if (foldedThrough) {
    const lagDays = (Date.now() - foldedThrough.getTime()) / 86_400_000;
    if (lagDays > rawCutoffDays) {
      console.error(`[worker] retention: hourly rollups are ${Math.floor(lagDays)}d behind (retention window ${rawCutoffDays}d); raw partitions are being kept so the fold can catch up`);
    }
  }

  // 3. Trim the SSE tail table by age.
  await duty("live_events", () => getPool().execute(
    `DELETE FROM live_events WHERE created_at < (UTC_TIMESTAMP() - INTERVAL ? MINUTE)`,
    [cfg.retention.live_events_minutes],
  ));

  // 3b. records_history grows one row per superseded record and was never pruned by anything.
  //     Age-bounded by the same event-history window as the other append-only history tables.
  if (cfg.retention.event_history_days > 0) {
    await duty("records_history", () => getPool().execute(
      `DELETE FROM records_history WHERE superseded_at < (UTC_TIMESTAMP() - INTERVAL ? DAY) LIMIT 50000`,
      [cfg.retention.event_history_days],
    ));
  }

  // 4. Prune the unbounded activity-driven event tables by age (these are not partitioned, so use
  //    a chunked DELETE; the 30-min cadence drains any backlog over several runs without a giant
  //    lock). 0 disables. These grow with chat / mobile-node / traceroute volume.
  const evtDays = cfg.retention.event_history_days;
  if (evtDays > 0) {
    for (const tbl of ["text_message", "node_position_events", "node_identity_events", "link_events"]) {
      await duty(tbl, () => getPool().execute(
        `DELETE FROM ${tbl} WHERE observed_at < (UTC_TIMESTAMP() - INTERVAL ? DAY) LIMIT 50000`,
        [evtDays],
      ));
    }
  }

  // 5. Non-partitioned rollup tables: pruned only when rollups are not kept indefinitely.
  if (!cfg.retention.rollups_indefinite) {
    // records_history is included because nothing else ever swept it and nothing reads it beyond
    // the records board's own history view.
    for (const tbl of ["node_rollup_hour", "reception_rollup_day"]) {
      await duty(tbl, () => getPool().execute(
        `DELETE FROM ${tbl} WHERE bucket_start < (UTC_TIMESTAMP() - INTERVAL ? DAY) LIMIT 50000`,
        [cfg.retention.rollup_days],
      ));
    }
  }
}
