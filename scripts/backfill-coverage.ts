// One-time backfill of coverage_sample (the /wardrive RF heat map) from history.
//
// Two sources, both direct-only (Rule 4):
//   1. HopWatch's own history: node_position_events JOIN rf_direct receptions. Every GPS position
//      we ever heard direct, with the gateway that heard it and its SNR/RSSI.
//   2. A MeshView packet DB (optional): its packet + packet_seen tables carry hop_start/hop_limit
//      (direct == equal), rx_snr/rx_rssi and the gateway node, with the position in the protobuf
//      payload. Decoded via the sanctioned decode helper (Rule 7). MeshView subscribes far more of
//      the mesh than one HopWatch instance, so this widens the map well beyond the local network.
//
// Idempotent: it deletes only its OWN prior rows (source='backfill' / 'meshview') before each pass,
// so re-running refreshes rather than duplicates. Live capture (source='live') is never touched.
//
// Run on the box:  node --env-file=.env scripts/backfill-coverage.ts
// Flags:  --no-meshview            skip the MeshView pass
//         --meshview=/path/to.db   MeshView packet DB (default /root/meshview/packets.db)
import { getPool, closePool } from "../src/db/client.ts";
import { toMysqlUtc } from "../src/lib/time.ts";
import { decodeMeshPacketPosition } from "../src/meshtastic/decode.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";

const MESHVIEW_DB = process.argv.find((a) => a.startsWith("--meshview="))?.split("=")[1] || "/root/meshview/packets.db";
const SKIP_MESHVIEW = process.argv.includes("--no-meshview");
const SKIP_HOPWATCH = process.argv.includes("--skip-hopwatch");

const validLatLon = (lat: number, lon: number) =>
  Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) &&
  lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

async function backfillHopwatch(): Promise<number> {
  const pool = getPool();
  await pool.query("DELETE FROM coverage_sample WHERE source='backfill'");
  const [maxRows] = await pool.query<RowDataPacket[]>("SELECT COALESCE(MAX(event_id),0) AS maxId FROM node_position_events");
  const maxId = Number(maxRows[0]?.maxId ?? 0);
  let inserted = 0;
  const STEP = 50000;
  for (let lo = 0; lo < maxId; lo += STEP) {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO coverage_sample
         (sample_time, latitude, longitude, gateway_id, from_node_id, rx_snr, rx_rssi, channel_id, hops, source)
       SELECT r.rx_time, e.latitude, e.longitude, r.gateway_id, r.from_node_id, r.rx_snr, r.rx_rssi, NULL,
              CASE WHEN r.reception_class = 'rf_direct' THEN 0
                   WHEN r.hop_start IS NOT NULL AND r.hop_limit IS NOT NULL AND r.hop_start >= r.hop_limit THEN r.hop_start - r.hop_limit
                   ELSE NULL END,
              'backfill'
       FROM node_position_events e
       JOIN receptions r ON r.packet_id = e.source_packet_id AND r.reception_class IN ('rf_direct', 'rf_relayed')
       WHERE e.event_id > ? AND e.event_id <= ?
         AND e.source_packet_id IS NOT NULL
         AND e.latitude BETWEEN -90 AND 90 AND e.longitude BETWEEN -180 AND 180
         AND NOT (e.latitude = 0 AND e.longitude = 0)`,
      [lo, lo + STEP],
    );
    inserted += res.affectedRows || 0;
  }
  return inserted;
}

async function backfillMeshview(): Promise<number> {
  if (SKIP_MESHVIEW) { console.log("[meshview] skipped (--no-meshview)"); return 0; }
  if (!existsSync(MESHVIEW_DB)) { console.log(`[meshview] skipped (no db at ${MESHVIEW_DB})`); return 0; }
  const pool = getPool();
  await pool.query("DELETE FROM coverage_sample WHERE source='meshview'");
  const db = new DatabaseSync(MESHVIEW_DB, { readOnly: true });
  // Direct (hop_start == hop_limit), not the sender's own uplink (gw != from), and carrying a real
  // RF metric (not the all-zero placeholder of an injected copy).
  const rows = db.prepare(
    `SELECT p.payload AS payload, ps.node_id AS gw, p.from_node_id AS frm,
            ps.rx_time AS rxt, ps.rx_snr AS snr, ps.rx_rssi AS rssi, p.channel AS chan,
            ps.hop_start AS hs, ps.hop_limit AS hl
       FROM packet p JOIN packet_seen ps ON ps.packet_id = p.id
      WHERE p.portnum = 3
        AND ps.hop_start IS NOT NULL AND ps.hop_start >= ps.hop_limit
        AND ps.node_id <> p.from_node_id
        AND ps.rx_time > 0
        AND (ps.rx_rssi <> 0 OR ps.rx_snr <> 0)`,
  ).all() as Array<{ payload: Uint8Array; gw: number; frm: number; rxt: number; snr: number | null; rssi: number | null; chan: string | null; hs: number; hl: number }>;
  db.close();
  console.log(`[meshview] ${rows.length} candidate direct+relayed position receptions, decoding...`);

  let inserted = 0, decoded = 0;
  let batch: unknown[][] = [];
  const flush = async () => {
    if (!batch.length) return;
    const values = batch.map(() => "(?,?,?,?,?,?,?,?,?, 'meshview')").join(",");
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO coverage_sample
         (sample_time, latitude, longitude, gateway_id, from_node_id, rx_snr, rx_rssi, channel_id, hops, source)
       VALUES ${values}`,
      batch.flat(),
    );
    inserted += res.affectedRows || 0;
    batch = [];
  };
  for (const r of rows) {
    const bytes = r.payload instanceof Uint8Array ? r.payload : new Uint8Array(r.payload as ArrayBufferLike);
    const pos = await decodeMeshPacketPosition(bytes);
    if (!pos || !validLatLon(pos.latitude, pos.longitude)) continue;
    decoded++;
    const hops = r.hs >= r.hl ? r.hs - r.hl : null; // 0 = direct, > 0 = relayed
    batch.push([
      toMysqlUtc(new Date(Number(r.rxt) * 1000)), pos.latitude, pos.longitude,
      r.gw >>> 0, r.frm >>> 0,
      r.snr === 0 ? null : r.snr, r.rssi === 0 ? null : r.rssi, r.chan || null, hops,
    ]);
    if (batch.length >= 1000) await flush();
  }
  await flush();
  console.log(`[meshview] decoded ${decoded} with a valid fix`);
  return inserted;
}

(async () => {
  let a = 0;
  if (SKIP_HOPWATCH) {
    console.log("[backfill] HopWatch: skipped (--skip-hopwatch)");
  } else {
    console.log("[backfill] HopWatch history...");
    a = await backfillHopwatch();
    console.log(`[backfill] HopWatch: ${a} samples`);
  }
  console.log("[backfill] MeshView store...");
  const b = await backfillMeshview();
  console.log(`[backfill] MeshView: ${b} samples`);
  const pool = getPool();
  const [tot] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n, MIN(sample_time) AS mn, MAX(sample_time) AS mx FROM coverage_sample",
  );
  console.log(`[backfill] coverage_sample total: ${tot[0]?.n} (${tot[0]?.mn} .. ${tot[0]?.mx})`);
  await closePool();
  process.exit(0);
})().catch((e) => { console.error("[backfill] FAILED:", e); process.exit(1); });
