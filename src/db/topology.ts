// Persistent mesh topology accumulated from traceroutes, plus per-node freshness used by the
// auto-traceroute scheduler. See migration 0023 and src/lib/topology.ts (pure helpers).
import { query } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { pathEdges } from "../lib/topology.ts";
import type { PoolConnection } from "mysql2/promise";

/**
 * Fold one observed traceroute into the accumulated topology. `path` is the full node path
 * (origin first, destination last); `snrTowards` is the per-hop SNR if present. Upserts each
 * undirected hop into mesh_link and stamps traceroute_state for the endpoints so the
 * scheduler treats them as freshly known.
 */
/**
 * Fold a traceroute's hop path into the persistent topology.
 *
 * `conn` is REQUIRED to be the caller's transaction. `times_seen = times_seen + 1` is not
 * idempotent, and running it on a pooled connection in autocommit while the caller's batch
 * transaction was still open meant it committed immediately and survived that transaction's
 * rollback: the batch retried each item individually, the packets row was gone so the traceroute
 * looked new again, and every edge on the route was incremented a second time. Permanently wrong
 * /topology edge weights, once per batch failure.
 */
export async function recordTraceroute(
  conn: PoolConnection,
  path: number[],
  snrTowards: number[] | null | undefined,
): Promise<void> {
  const now = toMysqlUtc(new Date());
  const edges = pathEdges(path, snrTowards ? (i) => (Number.isFinite(snrTowards[i]) ? Number(snrTowards[i]) : null) : undefined);
  for (const e of edges) {
    await conn.execute(
      `INSERT INTO mesh_link (a_node_id, b_node_id, first_seen_at, last_seen_at, last_snr, times_seen)
       VALUES (?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE last_seen_at=VALUES(last_seen_at), last_snr=COALESCE(VALUES(last_snr), last_snr), times_seen=times_seen+1`,
      [e.a, e.b, now, now, e.snr],
    );
  }
  // Mark route freshness for the endpoints of the trace (origin + destination).
  const endpoints = [path[0], path[path.length - 1]].filter((n): n is number => !!n && n > 0);
  const hops = Math.max(0, path.length - 1);
  for (const n of [...new Set(endpoints)]) {
    await conn.execute(
      `INSERT INTO traceroute_state (node_id, last_result_at, attempts, last_hop_count)
       VALUES (?,?,0,?)
       ON DUPLICATE KEY UPDATE last_result_at=VALUES(last_result_at), last_hop_count=VALUES(last_hop_count)`,
      [n, now, hops],
    );
  }
}

export interface TopologyEdge {
  a_node_id: number; b_node_id: number; a_name: string | null; b_name: string | null;
  last_seen_at: string; last_snr: number | null; times_seen: number;
}

/** Accumulated topology edges (most recently seen first), joined with node names. */
export async function getTopology(limit = 2000): Promise<TopologyEdge[]> {
  return query<TopologyEdge>(
    `SELECT l.a_node_id, l.b_node_id, l.last_seen_at, l.last_snr, l.times_seen,
            na.long_name AS a_name, nb.long_name AS b_name
     FROM mesh_link l
     LEFT JOIN nodes na ON na.node_id=l.a_node_id
     LEFT JOIN nodes nb ON nb.node_id=l.b_node_id
     ORDER BY l.last_seen_at DESC
     LIMIT ${Math.min(Math.max(limit, 1), 10000)}`,
  );
}

export interface TraceCoverage {
  active: number;   // nodes seen in the last 24h
  known: number;    // of those, how many have a traceroute result
  requested: number;// of those, how many have been requested but no result yet
  links: number;    // accumulated topology edges
  stale: { node_id: number; long_name: string | null; last_result_at: string | null; last_seen_at: string | null }[];
}

/** Coverage summary + the next nodes most in need of a (re)trace. */
export async function tracerouteCoverage(intervalHours = 24): Promise<TraceCoverage> {
  const [agg] = await query<{ active: number; known: number; requested: number }>(
    `SELECT
       COUNT(*) active,
       SUM(ts.last_result_at IS NOT NULL) known,
       SUM(ts.last_result_at IS NULL AND ts.last_requested_at IS NOT NULL) requested
     FROM nodes n
     LEFT JOIN traceroute_state ts ON ts.node_id=n.node_id
     WHERE n.last_seen_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR`,
  );
  const [links] = await query<{ c: number }>(`SELECT COUNT(*) c FROM mesh_link`);
  const stale = await query<{ node_id: number; long_name: string | null; last_result_at: string | null; last_seen_at: string | null }>(
    `SELECT n.node_id, n.long_name, ts.last_result_at, n.last_seen_at
     FROM nodes n
     LEFT JOIN traceroute_state ts ON ts.node_id=n.node_id
     WHERE n.last_seen_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR
       AND (ts.last_result_at IS NULL OR ts.last_result_at < UTC_TIMESTAMP() - INTERVAL ? HOUR)
     ORDER BY (ts.last_result_at IS NOT NULL), ts.last_result_at ASC, n.last_seen_at DESC
     LIMIT 20`,
    [intervalHours],
  );
  return {
    active: Number(agg?.active ?? 0), known: Number(agg?.known ?? 0), requested: Number(agg?.requested ?? 0),
    links: Number(links?.c ?? 0), stale,
  };
}

/**
 * Pick the next nodes to traceroute: active recently, not our own node, not muted, and either
 * never requested or requested longer ago than `intervalHours`. Never-resulted nodes come
 * first, then the stalest results. Marks the chosen nodes as requested (so a later run skips
 * them for the interval) and returns them for enqueueing.
 */
export async function claimTracerouteTargets(opts: { fromNode: number; intervalHours: number; maxActiveAgeHours: number; limit: number; onlyRouters?: boolean }): Promise<number[]> {
  const routerClause = opts.onlyRouters ? " AND (n.is_gateway = 1 OR UPPER(COALESCE(n.role,'')) LIKE '%ROUTER%' OR UPPER(COALESCE(n.role,'')) LIKE '%REPEATER%')" : "";
  const rows = await query<{ node_id: number }>(
    `SELECT n.node_id
     FROM nodes n
     LEFT JOIN traceroute_state ts ON ts.node_id=n.node_id
     WHERE n.node_id <> ?
       AND (n.mute_hidden = 0 OR n.mute_hidden IS NULL)
       AND n.last_seen_at >= UTC_TIMESTAMP() - INTERVAL ? HOUR
       AND (ts.last_requested_at IS NULL OR ts.last_requested_at < UTC_TIMESTAMP() - INTERVAL ? HOUR)${routerClause}
     ORDER BY (ts.last_result_at IS NOT NULL), ts.last_result_at ASC, n.last_seen_at DESC
     LIMIT ?`,
    [opts.fromNode >>> 0, Math.floor(opts.maxActiveAgeHours), Math.floor(opts.intervalHours), Math.max(1, Math.floor(opts.limit))],
  );
  const now = toMysqlUtc(new Date());
  const ids: number[] = [];
  for (const r of rows) {
    const id = Number(r.node_id);
    await query(
      `INSERT INTO traceroute_state (node_id, last_requested_at, attempts)
       VALUES (?,?,1)
       ON DUPLICATE KEY UPDATE last_requested_at=VALUES(last_requested_at), attempts=attempts+1`,
      [id, now],
    );
    ids.push(id);
  }
  return ids;
}
