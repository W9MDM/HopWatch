// Continuous rollups. Folds completed hours of receptions into the rollup tables
// and aggregates hourly -> daily. Idempotent (ON DUPLICATE KEY replaces the bucket)
// and watermark-driven so restarts resume cleanly (spec §3).
//
// Note on p50: the hourly fold stores count/sum/sumsq/min/max (avg + stddev derivable)
// and leaves rssi_p50/snr_p50 NULL. A dedicated percentile pass (Phase 4 tropo work)
// populates true medians from retained raw; the columns exist now so no re-ingest.
import { getPool } from "../db/client.ts";
import { toMysqlUtc, floorHourUtc, floorDayUtc, addDays } from "../lib/time.ts";

const MAX_HOURS_PER_RUN = 72;
const MAX_DAYS_PER_RUN = 400;

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3_600_000);
}

export async function getWatermark(name: string): Promise<Date | null> {
  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT last_bucket_folded FROM rollup_watermark WHERE rollup_name=?",
    [name],
  );
  const r = (rows as { last_bucket_folded: string | null }[])[0];
  return r?.last_bucket_folded ? new Date(r.last_bucket_folded + "Z") : null;
}

async function setWatermark(name: string, bucket: Date): Promise<void> {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO rollup_watermark (rollup_name, last_bucket_folded, updated_at) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE last_bucket_folded=VALUES(last_bucket_folded), updated_at=VALUES(updated_at)`,
    [name, toMysqlUtc(bucket), toMysqlUtc(new Date())],
  );
}

/** Fold all completed hours since the watermark. */
export async function runHourlyRollups(): Promise<number> {
  const lastComplete = floorHourUtc(new Date()); // current hour is incomplete -> exclusive upper bound

  const wm = await getWatermark("hourly");
  // Start at the hour AFTER the watermark; if none yet, at the earliest reception hour.
  let h: Date;
  if (wm) {
    h = addHours(floorHourUtc(wm), 1);
  } else {
    const earliest = await earliestReceptionHour();
    if (!earliest) return 0; // no data yet
    h = earliest;
  }

  let folded = 0;
  while (folded < MAX_HOURS_PER_RUN && h < lastComplete) {
    const from = toMysqlUtc(h);
    const to = toMysqlUtc(addHours(h, 1));
    await foldReceptionHour(from, to, from);
    await foldNodeHour(from, to, from);
    await foldGatewayHour(from, to, from);
    await foldMeshHour(from, to, from);
    await setWatermark("hourly", h);
    folded++;
    h = addHours(h, 1);
  }
  return folded;
}

/**
 * Re-fold the last `hours` completed hours.
 *
 * The frontier watermark is strictly monotonic, so an hour is folded about a minute after it ends
 * and never revisited. But `rx_time` is the gateway-reported time whenever it is plausible (ingest
 * bounds only the future), so a reception can legitimately land in an already-folded hour: a gateway
 * whose clock runs slow, or a store-and-forward replay, which upstream re-sends carrying the
 * ORIGINAL packet's rx_time. Those receptions existed in `receptions` but appeared in no rollup, and
 * nothing ever revisited the hour, so the loss was permanent.
 *
 * All four fold statements are upserts keyed on the bucket, so re-folding is idempotent: it
 * recomputes the bucket from the raw rows rather than adding to it. This runs on the slow (30 min)
 * loop, not the fast one, so a wide window costs a handful of bounded aggregates per half hour.
 */
export async function refoldRecentHours(hours: number): Promise<number> {
  if (hours <= 0) return 0;
  const lastComplete = floorHourUtc(new Date());
  const wm = await getWatermark("hourly");
  if (!wm) return 0; // nothing folded yet: the frontier pass will cover it
  let done = 0;
  for (let i = 1; i <= hours; i++) {
    const h = addHours(lastComplete, -i);
    // Only hours the frontier has already claimed. Anything newer is not folded yet, and folding it
    // here would let the frontier skip it.
    if (h > floorHourUtc(wm)) continue;
    const from = toMysqlUtc(h);
    const to = toMysqlUtc(addHours(h, 1));
    await foldReceptionHour(from, to, from);
    await foldNodeHour(from, to, from);
    await foldGatewayHour(from, to, from);
    await foldMeshHour(from, to, from);
    done++;
  }
  return done;
}

async function earliestReceptionHour(): Promise<Date | null> {
  const pool = getPool();
  const [rows] = await pool.query("SELECT MIN(rx_time) AS m FROM receptions");
  const m = (rows as { m: string | null }[])[0]?.m;
  return m ? floorHourUtc(new Date(m + "Z")) : null;
}

async function foldReceptionHour(from: string, to: string, bucket: string): Promise<void> {
  const pool = getPool();
  // Raise the GROUP_CONCAT limit so the per-group median trick is not truncated on
  // busy pair-hours (the tropo baseline reads these p50 values).
  await pool.execute(`SET SESSION group_concat_max_len = 1048576`).catch(() => {});
  await pool.execute(
    `INSERT INTO reception_rollup_hour
       (bucket_start, gateway_id, node_id, packet_count, direct_count, relayed_count, unknown_count,
        hops_min,
        rssi_min, rssi_max, rssi_sum, rssi_sumsq, rssi_p50, snr_min, snr_max, snr_sum, snr_sumsq, snr_p50,
        rssi_direct_sum, rssi_direct_count, rssi_direct_p50, snr_direct_p50, snr_direct_sum, snr_direct_count)
     SELECT ?, gateway_id, from_node_id,
        COUNT(*),
        SUM(reception_class='rf_direct'),
        SUM(reception_class='rf_relayed'),
        SUM(reception_class IN ('rf_direct_low_conf','unknown')),
        -- Fewest RF hops in the hour (rf_direct/rf_relayed only, Rule 4). CASTs avoid MySQL
        -- unsigned-subtraction errors and the BETWEEN excludes malformed hop fields (audit C10).
        MIN(CASE WHEN reception_class IN ('rf_direct','rf_relayed')
                  AND hop_start IS NOT NULL AND hop_limit IS NOT NULL
                  AND CAST(hop_start AS SIGNED) - CAST(hop_limit AS SIGNED) BETWEEN 0 AND 255
                 THEN CAST(hop_start AS SIGNED) - CAST(hop_limit AS SIGNED) END),
        MIN(rx_rssi), MAX(rx_rssi), COALESCE(SUM(rx_rssi),0), COALESCE(SUM(rx_rssi*rx_rssi),0),
        CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(GROUP_CONCAT(rx_rssi ORDER BY rx_rssi SEPARATOR ','), ',', CEIL(COUNT(rx_rssi)/2)), ',', -1) AS SIGNED),
        MIN(rx_snr), MAX(rx_snr), COALESCE(SUM(rx_snr),0), COALESCE(SUM(rx_snr*rx_snr),0),
        CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(GROUP_CONCAT(rx_snr ORDER BY rx_snr SEPARATOR ','), ',', CEIL(COUNT(rx_snr)/2)), ',', -1) AS DECIMAL(6,2)),
        -- Direct-only (rf_direct) aggregates: only zero-hop RF characterizes the source's link.
        COALESCE(SUM(CASE WHEN reception_class='rf_direct' THEN rx_rssi END),0),
        SUM(reception_class='rf_direct' AND rx_rssi IS NOT NULL),
        CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN reception_class='rf_direct' THEN rx_rssi END ORDER BY rx_rssi SEPARATOR ','), ',', CEIL(SUM(reception_class='rf_direct' AND rx_rssi IS NOT NULL)/2)), ',', -1) AS SIGNED),
        CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN reception_class='rf_direct' THEN rx_snr END ORDER BY rx_snr SEPARATOR ','), ',', CEIL(SUM(reception_class='rf_direct' AND rx_snr IS NOT NULL)/2)), ',', -1) AS DECIMAL(6,2)),
        COALESCE(SUM(CASE WHEN reception_class='rf_direct' THEN rx_snr END),0),
        SUM(reception_class='rf_direct' AND rx_snr IS NOT NULL)
     FROM receptions
     WHERE rx_time >= ? AND rx_time < ? AND reception_class IN ('rf_direct','rf_direct_low_conf','rf_relayed','unknown')
     GROUP BY gateway_id, from_node_id
     ON DUPLICATE KEY UPDATE
       packet_count=VALUES(packet_count), direct_count=VALUES(direct_count),
       relayed_count=VALUES(relayed_count), unknown_count=VALUES(unknown_count),
       hops_min=VALUES(hops_min),
       rssi_min=VALUES(rssi_min), rssi_max=VALUES(rssi_max), rssi_sum=VALUES(rssi_sum), rssi_sumsq=VALUES(rssi_sumsq), rssi_p50=VALUES(rssi_p50),
       snr_min=VALUES(snr_min), snr_max=VALUES(snr_max), snr_sum=VALUES(snr_sum), snr_sumsq=VALUES(snr_sumsq), snr_p50=VALUES(snr_p50),
       rssi_direct_sum=VALUES(rssi_direct_sum), rssi_direct_count=VALUES(rssi_direct_count),
       rssi_direct_p50=VALUES(rssi_direct_p50), snr_direct_p50=VALUES(snr_direct_p50),
       snr_direct_sum=VALUES(snr_direct_sum), snr_direct_count=VALUES(snr_direct_count)`,
    [bucket, from, to],
  );
}

async function foldNodeHour(from: string, to: string, bucket: string): Promise<void> {
  await getPool().execute(
    `INSERT INTO node_rollup_hour
       (bucket_start, node_id, packet_count, reception_count, direct_heard_count, relayed_count, unique_gateways)
     SELECT ?, from_node_id, COUNT(DISTINCT packet_id), COUNT(*),
        SUM(reception_class='rf_direct'), SUM(reception_class='rf_relayed'),
        -- RF classes only (Rule 4). Counting every class made "gateway coverage" include the node's
        -- OWN mqtt_self uplinks, where gateway_id equals from_node_id, and mqtt_injected copies that
        -- no gateway heard on the air. A node that merely uplinks its own traffic to two brokers
        -- therefore scored as having real gateway coverage, and this column is the only input to the
        -- published health score's gateway_coverage factor, so the inflation went straight into it.
        COUNT(DISTINCT CASE WHEN reception_class IN ('rf_direct','rf_direct_low_conf','rf_relayed')
                            THEN gateway_id END)
     FROM receptions WHERE rx_time >= ? AND rx_time < ?
     GROUP BY from_node_id
     ON DUPLICATE KEY UPDATE
       packet_count=VALUES(packet_count), reception_count=VALUES(reception_count),
       direct_heard_count=VALUES(direct_heard_count), relayed_count=VALUES(relayed_count),
       unique_gateways=VALUES(unique_gateways)`,
    [bucket, from, to],
  );
}

async function foldGatewayHour(from: string, to: string, bucket: string): Promise<void> {
  await getPool().execute(
    `INSERT INTO gateway_rollup_hour
       (bucket_start, gateway_id, packet_count, reception_count, direct_heard_nodes, last_seen_at)
     SELECT ?, gateway_id, COUNT(DISTINCT packet_id), COUNT(*),
        COUNT(DISTINCT IF(reception_class='rf_direct', from_node_id, NULL)), MAX(rx_time)
     FROM receptions WHERE rx_time >= ? AND rx_time < ?
     GROUP BY gateway_id
     ON DUPLICATE KEY UPDATE
       packet_count=VALUES(packet_count), reception_count=VALUES(reception_count),
       direct_heard_nodes=VALUES(direct_heard_nodes), last_seen_at=VALUES(last_seen_at)`,
    [bucket, from, to],
  );
}

async function foldMeshHour(from: string, to: string, bucket: string): Promise<void> {
  await getPool().execute(
    `INSERT INTO mesh_rollup_hour
       (bucket_start, active_nodes, unique_gateways, total_packets, total_receptions, avg_chan_util, new_nodes)
     SELECT ?, COUNT(DISTINCT from_node_id), COUNT(DISTINCT gateway_id),
        COUNT(DISTINCT packet_id), COUNT(*),
        (SELECT AVG(value) FROM node_telemetry WHERE metric='chan_util' AND observed_at >= ? AND observed_at < ?),
        (SELECT COUNT(*) FROM nodes WHERE first_seen_at >= ? AND first_seen_at < ?)
     FROM receptions WHERE rx_time >= ? AND rx_time < ?
     -- Unlike the other folds this has no GROUP BY, so an EMPTY hour still yields one row: all
     -- zeros. That turned any gap into fabricated data rather than absent data. A gap happens for
     -- real: the fold walking forward from a stale watermark over hours whose raw partitions
     -- retention has already dropped, or simply a mesh with no traffic for an hour. HAVING filters
     -- the single implicit group, so an empty hour now inserts nothing at all.
     HAVING COUNT(*) > 0
     ON DUPLICATE KEY UPDATE
       active_nodes=VALUES(active_nodes), unique_gateways=VALUES(unique_gateways),
       total_packets=VALUES(total_packets), total_receptions=VALUES(total_receptions),
       avg_chan_util=VALUES(avg_chan_util), new_nodes=VALUES(new_nodes)`,
    [bucket, from, to, from, to, from, to],
  );
}

/**
 * Materialize the direct-heard roster from the gateway_node_link aggregate.
 * first/last-direct and direct counts are exact; rssi_avg is an all-class
 * approximation (documented) pending a direct-only sum column.
 */
export async function materializeDirectRoster(): Promise<void> {
  await getPool().execute(
    `INSERT INTO gateway_heard_direct
       (gateway_id, node_id, first_heard_direct, last_heard_direct, reception_count,
        rssi_min, rssi_max, rssi_avg, snr_min, snr_max, snr_avg, last_rssi, last_snr, status)
     SELECT gateway_id, node_id, first_direct_at, last_direct_at, direct_count,
        -- This is the DIRECT-heard roster, so every RF statistic in it must come from zero-hop
        -- receptions only (Rule 4). It previously used the all-class min/max/sum divided by the
        -- all-class count, so a node reached mainly through a strong nearby relay published an
        -- inflated "direct" signal here and in everything that reads this table.
        rssi_direct_min, rssi_direct_max,
        rssi_direct_sum / NULLIF(rssi_direct_count, 0),
        snr_direct_min, snr_direct_max,
        snr_direct_sum / NULLIF(snr_direct_count, 0),
        last_direct_rssi, last_direct_snr,
        CASE
          WHEN last_direct_at >= (UTC_TIMESTAMP() - INTERVAL 2 HOUR) THEN 'active'
          WHEN last_direct_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR) THEN 'stale'
          ELSE 'offline'
        END
     FROM gateway_node_link
     WHERE direct_count > 0 AND first_direct_at IS NOT NULL
     ON DUPLICATE KEY UPDATE
       first_heard_direct=VALUES(first_heard_direct), last_heard_direct=VALUES(last_heard_direct),
       reception_count=VALUES(reception_count), rssi_min=VALUES(rssi_min), rssi_max=VALUES(rssi_max),
       rssi_avg=VALUES(rssi_avg), snr_min=VALUES(snr_min), snr_max=VALUES(snr_max), snr_avg=VALUES(snr_avg),
       last_rssi=VALUES(last_rssi), last_snr=VALUES(last_snr), status=VALUES(status)`,
  );
}

/**
 * Aggregate completed days from the hourly rollups into the *_day tables.
 *
 * Watermark-driven and bounded on the RAW partitioning column. It used to be a single
 * `WHERE DATE(bucket_start) < ?` with no lower bound, which applied a function to the partitioning
 * key: no partition pruning, no index use, so every run full-scanned all surviving
 * reception_rollup_hour partitions (365 days by default) and rewrote every historical day row for
 * every (gateway, node) pair. It also resurrected exactly what retention had just deleted: with
 * rollups_indefinite false and rollup_days below reception_rollup_hour_days, retention deletes old
 * reception_rollup_day rows and this re-inserted them from the still-present hourly rows on the next
 * tick, forever.
 *
 * The watermark day is re-folded on every run, because its hours can still change (a late reception
 * re-folds an hour, see refoldRecentHours); everything before it is left alone.
 */
export async function runDailyRollups(cfg?: { retention: { rollups_indefinite: boolean; rollup_days: number } }): Promise<number> {
  const todayStart = floorDayUtc(new Date());
  // Never fold a day retention would immediately delete again.
  const floor = cfg && !cfg.retention.rollups_indefinite
    ? floorDayUtc(addDays(new Date(), -cfg.retention.rollup_days))
    : null;

  const wm = await getWatermark("daily");
  let d: Date;
  if (wm) {
    d = floorDayUtc(wm);
  } else {
    const earliest = await earliestRollupHourDay();
    if (!earliest) return 0;
    d = earliest;
  }
  if (floor && d < floor) d = floor;

  let days = 0;
  while (d < todayStart && days < MAX_DAYS_PER_RUN) {
    await foldReceptionDay(d);
    await setWatermark("daily", d);
    d = addDays(d, 1);
    days++;
  }
  return days;
}

async function earliestRollupHourDay(): Promise<Date | null> {
  const [rows] = await getPool().query("SELECT MIN(bucket_start) AS m FROM reception_rollup_hour");
  const m = (rows as { m: string | null }[])[0]?.m;
  return m ? floorDayUtc(new Date(String(m).replace(" ", "T") + "Z")) : null;
}

async function foldReceptionDay(day: Date): Promise<void> {
  const from = toMysqlUtc(day);
  const to = toMysqlUtc(addDays(day, 1));
  await getPool().execute(
    `INSERT INTO reception_rollup_day
       (bucket_start, gateway_id, node_id, packet_count, direct_count, relayed_count, unknown_count,
        rssi_min, rssi_max, rssi_sum, rssi_sumsq, snr_min, snr_max, snr_sum, snr_sumsq)
     SELECT DATE(?), gateway_id, node_id, SUM(packet_count), SUM(direct_count),
        SUM(relayed_count), SUM(unknown_count), MIN(rssi_min), MAX(rssi_max), SUM(rssi_sum), SUM(rssi_sumsq),
        MIN(snr_min), MAX(snr_max), SUM(snr_sum), SUM(snr_sumsq)
     FROM reception_rollup_hour WHERE bucket_start >= ? AND bucket_start < ?
     GROUP BY gateway_id, node_id
     ON DUPLICATE KEY UPDATE packet_count=VALUES(packet_count), direct_count=VALUES(direct_count),
       relayed_count=VALUES(relayed_count), unknown_count=VALUES(unknown_count),
       rssi_min=VALUES(rssi_min), rssi_max=VALUES(rssi_max), rssi_sum=VALUES(rssi_sum), rssi_sumsq=VALUES(rssi_sumsq),
       snr_min=VALUES(snr_min), snr_max=VALUES(snr_max), snr_sum=VALUES(snr_sum), snr_sumsq=VALUES(snr_sumsq)`,
    [from, from, to],
  );
}
