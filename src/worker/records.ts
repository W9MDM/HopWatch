import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";

// Records board. Each record is a single row keyed by type; when a new value beats
// the current holder the old row is archived to records_history. Evidence is stored
// denormalized so records survive raw-row retention drops (spec §8).

interface Candidate {
  value: number;
  unit: string;
  nodeA: number | null;
  nodeB: number | null;
  evidence: Record<string, unknown>;
}

/**
 * Upsert one record.
 *
 * `monotonic` marks a record whose value only ever grows for the SAME holder, which is not a broken
 * record at all: "oldest continuously heard" is an age in days, so it beat itself on every 5-minute
 * worker tick by ~0.0035 days. Each tick archived the unchanged row into records_history (288 junk
 * rows a day, in a table nothing reads and retention did not sweep) and reset achieved_at, so the
 * one record that should have the OLDEST achieved_at always showed as achieved seconds ago. For
 * these, the value is refreshed in place while the holder is unchanged and only a change of holder
 * counts as superseding.
 */
async function upsertRecord(
  type: string,
  higherIsBetter: boolean,
  cand: Candidate | null,
  opts: { monotonic?: boolean } = {},
): Promise<void> {
  if (!cand || !Number.isFinite(cand.value)) return;
  const cur = await query<{ value: number; achieved_at: string; node_a: number | null }>(
    `SELECT value, achieved_at, node_a FROM records WHERE record_type=?`,
    [type],
  );
  const existing = cur[0];
  const beats = !existing || (higherIsBetter ? cand.value > existing.value : cand.value < existing.value);
  if (!beats) return;

  // Same holder on a monotonic record: refresh the value, keep achieved_at, archive nothing.
  if (existing && opts.monotonic && cand.nodeA !== null && Number(existing.node_a) === cand.nodeA) {
    await query(
      `UPDATE records SET value=?, unit=?, evidence=? WHERE record_type=?`,
      [cand.value, cand.unit, JSON.stringify(cand.evidence), type],
    );
    return;
  }

  const now = toMysqlUtc(new Date());
  if (existing) {
    await query(
      `INSERT INTO records_history (record_type, value, unit, node_a, node_b, achieved_at, superseded_at, evidence)
       SELECT record_type, value, unit, node_a, node_b, achieved_at, ?, evidence FROM records WHERE record_type=?`,
      [now, type],
    );
  }
  await query(
    `INSERT INTO records (record_type, value, unit, node_a, node_b, achieved_at, evidence)
       VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE value=VALUES(value), unit=VALUES(unit), node_a=VALUES(node_a),
       node_b=VALUES(node_b), achieved_at=VALUES(achieved_at), evidence=VALUES(evidence)`,
    [type, cand.value, cand.unit, cand.nodeA, cand.nodeB, now, JSON.stringify(cand.evidence)],
  );
}

const HAVERSINE = `6371 * ACOS(GREATEST(-1, LEAST(1, COS(RADIANS(gp.latitude))*COS(RADIANS(np.latitude))*
  COS(RADIANS(np.longitude)-RADIANS(gp.longitude)) + SIN(RADIANS(gp.latitude))*SIN(RADIANS(np.latitude)))))`;

// Sanity cap on distance-based records: a self-reported GPS spoof (e.g. Antarctica) would otherwise
// post a ~15000 km "longest link" that permanently tops the board. Real terrestrial LoRa DX is well
// under this; the cap kills obvious spoofs, and flagged (muted / position-ignored) nodes are also
// excluded below.
const MAX_LINK_KM = 500;
// Exclude flagged spoofers from both endpoints of a distance/DX record.
const NOT_FLAGGED = `gwn.mute_hidden=0 AND gwn.position_ignored=0 AND nn.mute_hidden=0 AND nn.position_ignored=0`;

export async function updateRecords(): Promise<void> {
  // Longest direct link (km).
  const longest = await query<{ gateway_id: number; node_id: number; distance_km: number; last_direct_rssi: number | null }>(
    `SELECT l.gateway_id, l.node_id, ${HAVERSINE} AS distance_km, l.last_direct_rssi
     FROM gateway_node_link l
     JOIN node_positions gp ON gp.node_id=l.gateway_id
     JOIN node_positions np ON np.node_id=l.node_id
     JOIN nodes gwn ON gwn.node_id=l.gateway_id
     JOIN nodes nn ON nn.node_id=l.node_id
     WHERE l.direct_count>0 AND l.gateway_id<>l.node_id AND gp.latitude IS NOT NULL AND np.latitude IS NOT NULL
       AND ${NOT_FLAGGED}
     HAVING distance_km <= ${MAX_LINK_KM}
     ORDER BY distance_km DESC LIMIT 1`,
  );
  if (longest[0]) {
    const r = longest[0];
    await upsertRecord("longest_direct_link_km", true, {
      value: Number(r.distance_km), unit: "km", nodeA: r.gateway_id, nodeB: r.node_id,
      evidence: { gateway_id: r.gateway_id, node_id: r.node_id, distance_km: Number(r.distance_km), last_direct_rssi: r.last_direct_rssi },
    });
  }

  // Most hops observed (last 30 days).
  const hops = await query<{ from_node_id: number; hops: number; rx_time: string }>(
    `SELECT from_node_id, (hop_start-hop_limit) AS hops, rx_time FROM receptions
     WHERE reception_class='rf_relayed' AND hop_start IS NOT NULL AND hop_limit IS NOT NULL
       AND hop_start <= 7 AND (hop_start-hop_limit) BETWEEN 0 AND 7
       AND rx_time >= (UTC_TIMESTAMP() - INTERVAL 30 DAY)
     ORDER BY hops DESC LIMIT 1`,
  );
  if (hops[0]) {
    await upsertRecord("most_hops", true, {
      value: Number(hops[0].hops), unit: "hops", nodeA: hops[0].from_node_id, nodeB: null,
      evidence: { node_id: hops[0].from_node_id, hops: Number(hops[0].hops), rx_time: hops[0].rx_time },
    });
  }

  // Fastest traceroute round trip.
  const rtt = await query<{ from_node_id: number; to_node_id: number; rtt_ms: number }>(
    `SELECT from_node_id, to_node_id, rtt_ms FROM link_events WHERE rtt_ms IS NOT NULL ORDER BY rtt_ms ASC LIMIT 1`,
  );
  if (rtt[0]) {
    await upsertRecord("fastest_traceroute_ms", false, {
      value: Number(rtt[0].rtt_ms), unit: "ms", nodeA: rtt[0].from_node_id, nodeB: rtt[0].to_node_id,
      evidence: { from: rtt[0].from_node_id, to: rtt[0].to_node_id, rtt_ms: Number(rtt[0].rtt_ms) },
    });
  }

  // Oldest continuously heard node (still active in last 24h).
  const oldest = await query<{ node_id: number; first_seen_at: string; age_days: number }>(
    `SELECT node_id, first_seen_at, TIMESTAMPDIFF(SECOND, first_seen_at, UTC_TIMESTAMP())/86400 AS age_days
     FROM nodes WHERE last_seen_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR) AND first_seen_at IS NOT NULL
     ORDER BY first_seen_at ASC LIMIT 1`,
  );
  if (oldest[0]) {
    // Monotonic: an age in days always grows, so only a change of holder is a new record.
    await upsertRecord("oldest_continuously_heard_days", true, {
      value: Number(oldest[0].age_days), unit: "days", nodeA: oldest[0].node_id, nodeB: null,
      evidence: { node_id: oldest[0].node_id, first_seen_at: oldest[0].first_seen_at },
    }, { monotonic: true });
  }

  // Best RSSI per km (distance-normalized: rssi + 20*log10(km); higher is better DX).
  const dx = await query<{ gateway_id: number; node_id: number; distance_km: number; last_direct_rssi: number; score: number }>(
    `SELECT l.gateway_id, l.node_id, ${HAVERSINE} AS distance_km, l.last_direct_rssi,
            l.last_direct_rssi + 20*LOG10(GREATEST(${HAVERSINE}, 0.001)) AS score
     FROM gateway_node_link l
     JOIN node_positions gp ON gp.node_id=l.gateway_id
     JOIN node_positions np ON np.node_id=l.node_id
     JOIN nodes gwn ON gwn.node_id=l.gateway_id
     JOIN nodes nn ON nn.node_id=l.node_id
     WHERE l.direct_count>0 AND l.last_direct_rssi IS NOT NULL AND l.gateway_id<>l.node_id
       AND gp.latitude IS NOT NULL AND np.latitude IS NOT NULL
       AND ${NOT_FLAGGED}
     HAVING distance_km > 0.5 AND distance_km <= ${MAX_LINK_KM}
     ORDER BY score DESC LIMIT 1`,
  );
  if (dx[0]) {
    await upsertRecord("best_rssi_per_km", true, {
      value: Number(dx[0].score), unit: "dB-adj", nodeA: dx[0].gateway_id, nodeB: dx[0].node_id,
      evidence: { gateway_id: dx[0].gateway_id, node_id: dx[0].node_id, distance_km: Number(dx[0].distance_km), last_direct_rssi: dx[0].last_direct_rssi },
    });
  }
}
