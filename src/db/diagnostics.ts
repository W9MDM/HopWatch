// 24-hour diagnostic bundle: "is data actually flowing, and is it being interpreted correctly?"
//
// This is deliberately a FLOW report, not a data export. Every section answers a question an
// operator asks after a deploy or when a mesh looks quiet, and the shape is stable so two
// bundles from different days can be diffed. It reads only aggregates plus small log tails, so
// it stays cheap on a partitioned install and never ships payload bytes or secrets.
import { query } from "./client.ts";
import { undecryptableSecrets } from "./appsettings.ts";
import { nodeLeaseHolder } from "./nodelease.ts";

const WINDOW_HOURS = 24;

export interface HourBucket { hour: string; [k: string]: string | number }

export interface DiagnosticsBundle {
  generated_at: string;
  window_hours: number;
  version: string;
  /** Point-in-time gates: is each process alive and current? */
  liveness: Record<string, unknown>;
  /** Ingest volume per hour, split by transport and broker. */
  ingest: { by_hour: HourBucket[]; by_broker: Record<string, number>; totals: Record<string, number> };
  /** Decode outcomes per hour. A rising malformed share is the first sign of a decode break. */
  decode: { by_hour: HourBucket[]; totals: Record<string, number> };
  /** Reception classification mix. The key signal that hop/RF-metadata handling is sane. */
  classification: { by_hour: HourBucket[]; totals: Record<string, number> };
  /** Presence rates for the implicit-presence protobuf fields, as a percentage of receptions. */
  field_presence: Record<string, number | null>;
  /** Port distribution, so a missing app (position, telemetry) is obvious. */
  ports: { port_num: number | null; port_count: number }[];
  /** TX outbox outcomes plus confirmation rate: did anything we sent actually reach the mesh? */
  tx: { by_state: Record<string, number>; confirmations: Record<string, number | null>; log_tail: unknown[] };
  /** MQTT bridge + RF patcher activity. */
  bridge: { forwards_by_direction: Record<string, number>; patched: number };
  /** Stored secrets the current master key cannot decrypt, named but never valued. */
  secrets: { undecryptable: string[] };
  /** Anything that looks wrong, computed server-side so the operator does not have to. */
  warnings: string[];
}

const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Fold rows of {hour, key, n} into one object per hour, so each hour is a single record. */
function pivotHours(rows: { hour: string; k: string | null; n: number }[]): HourBucket[] {
  const byHour = new Map<string, HourBucket>();
  for (const r of rows) {
    const hour = String(r.hour);
    let b = byHour.get(hour);
    if (!b) { b = { hour }; byHour.set(hour, b); }
    b[String(r.k ?? "unknown")] = Number(r.n);
  }
  return [...byHour.values()].sort((a, b) => String(a.hour).localeCompare(String(b.hour)));
}

function totalsOf(rows: { k: string | null; n: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.k ?? "unknown")] = Number(r.n);
  return out;
}

/**
 * Build the bundle. Each query is independently try/caught: a diagnostic report must still be
 * useful when one table is missing or a migration has not run, which is exactly when an operator
 * reaches for it.
 */
export async function buildDiagnostics(version: string): Promise<DiagnosticsBundle> {
  const warnings: string[] = [];
  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (e) {
      warnings.push(`could not read ${label}: ${(e as Error).message}`);
      return fallback;
    }
  };

  const W = WINDOW_HOURS;

  // --- Ingest volume, by hour and transport -------------------------------------------------
  const ingestRows = await safe("ingest by hour", () => query<{ hour: string; k: string; n: number }>(
    `SELECT DATE_FORMAT(rx_time, '%Y-%m-%dT%H:00Z') hour, transport k, COUNT(*) n
       FROM receptions
      WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
      GROUP BY hour, k ORDER BY hour`, [W]), []);

  const ingestBroker = await safe("ingest by broker", () => query<{ k: string | null; n: number }>(
    `SELECT p.source_broker_id k, COUNT(*) n
       FROM receptions r JOIN packets p ON p.id = r.packet_id AND p.first_seen_at = r.packet_first_seen_at
      WHERE r.rx_time >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
      GROUP BY k`, [W]), []);

  const ingestTotals = await safe("ingest totals", () => query<{ k: string; n: number }>(
    `SELECT transport k, COUNT(*) n FROM receptions
      WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) GROUP BY k`, [W]), []);

  // --- Decode outcomes ----------------------------------------------------------------------
  const decodeRows = await safe("decode by hour", () => query<{ hour: string; k: string; n: number }>(
    `SELECT DATE_FORMAT(first_seen_at, '%Y-%m-%dT%H:00Z') hour, decode_status k, COUNT(*) n
       FROM packets
      WHERE first_seen_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
      GROUP BY hour, k ORDER BY hour`, [W]), []);

  const decodeTotals = await safe("decode totals", () => query<{ k: string; n: number }>(
    `SELECT decode_status k, COUNT(*) n FROM packets
      WHERE first_seen_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) GROUP BY k`, [W]), []);

  // --- Reception classification -------------------------------------------------------------
  const classRows = await safe("classification by hour", () => query<{ hour: string; k: string; n: number }>(
    `SELECT DATE_FORMAT(rx_time, '%Y-%m-%dT%H:00Z') hour, reception_class k, COUNT(*) n
       FROM receptions
      WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
      GROUP BY hour, k ORDER BY hour`, [W]), []);

  const classTotals = await safe("classification totals", () => query<{ k: string; n: number }>(
    `SELECT reception_class k, COUNT(*) n FROM receptions
      WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) GROUP BY k`, [W]), []);

  // --- Field presence rates ------------------------------------------------------------------
  // rx_rssi / rx_snr / hop_start are proto3 implicit-presence scalars, so these percentages are
  // how an operator confirms presence is being recovered rather than read as a literal zero.
  const [presence] = await safe("field presence", () => query<Record<string, unknown>>(
    `SELECT COUNT(*) total,
            ROUND(100 * AVG(rx_rssi   IS NOT NULL), 1) pct_with_rssi,
            ROUND(100 * AVG(rx_snr    IS NOT NULL), 1) pct_with_snr,
            ROUND(100 * AVG(hop_start IS NOT NULL), 1) pct_with_hop_start,
            ROUND(100 * AVG(relay_node IS NOT NULL AND relay_node <> 0), 1) pct_with_relay_node
       FROM receptions WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)`, [W]), [{}]);

  const ports = await safe("port distribution", () => query<{ port_num: number | null; port_count: number }>(
    `SELECT port_num, COUNT(*) port_count FROM packets
      WHERE first_seen_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
      GROUP BY port_num ORDER BY port_count DESC LIMIT 30`, [W]), []);

  // --- TX outcomes ---------------------------------------------------------------------------
  const txStates = await safe("tx states", () => query<{ k: string; n: number }>(
    `SELECT state k, COUNT(*) n FROM tx_outbox
      WHERE created_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) GROUP BY k`, [W]), []);

  // heard/acked is the only proof a transmit actually reached the mesh: our own packet observed
  // coming back through a gateway. sent-but-never-heard is the signature of a wrong channel hash
  // or a topic root no gateway subscribes to.
  const [txConf] = await safe("tx confirmations", () => query<Record<string, unknown>>(
    `SELECT SUM(state IN ('sent','heard','acked')) sent_or_better,
            SUM(state IN ('heard','acked'))        heard_back,
            SUM(state = 'acked')                  acked,
            SUM(state = 'failed')                 failed,
            SUM(state = 'dry_run')                dry_run
       FROM tx_outbox WHERE created_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)`, [W]), [{}]);

  const txLog = await safe("tx log tail", () => query<unknown>(
    `SELECT created_at, outbox_id, level, message FROM tx_log
      WHERE created_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
      ORDER BY id DESC LIMIT 200`, [W]), []);

  // --- Bridge / patcher ----------------------------------------------------------------------
  const bridgeRows = await safe("bridge log", () => query<{ k: string; n: number }>(
    `SELECT direction k, COUNT(*) n FROM bridge_log
      WHERE bridged_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) GROUP BY k`, [W]), []);

  const [patched] = await safe("patcher activity", () => query<{ n: number }>(
    `SELECT COUNT(*) n FROM text_message
      WHERE bridged_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)`, [W]), [{ n: 0 }]);

  // --- Liveness ------------------------------------------------------------------------------
  const [live] = await safe("liveness", () => query<Record<string, unknown>>(
    `SELECT (SELECT COUNT(*) FROM broker_health) brokers_total,
            (SELECT SUM(connected=1) FROM broker_health) brokers_connected,
            -- Bounded to the last day so partition pruning keeps this cheap on huge reception
            -- tables (the same bound its twin in queries.ts already uses). A NULL result then means
            -- "no reception in 24h", which is exactly the signal the warning below wants anyway.
            (SELECT TIMESTAMPDIFF(SECOND, MAX(rx_time), UTC_TIMESTAMP()) FROM receptions
              WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL 1 DAY)) last_reception_age_sec,
            (SELECT TIMESTAMPDIFF(SECOND, MAX(created_at), UTC_TIMESTAMP()) FROM tx_log) last_tx_log_age_sec`), [{}]);

  const classT = totalsOf(classTotals);
  const decodeT = totalsOf(decodeTotals);
  const rxTotal = Number(presence?.total ?? 0);

  // --- Server-side interpretation ------------------------------------------------------------
  // Doing this here means the bundle tells the operator what is wrong, not just what happened.
  if (rxTotal === 0) warnings.push("no receptions in the window: ingest is not flowing");
  if (Number(live?.brokers_connected ?? 0) < Number(live?.brokers_total ?? 0)) {
    warnings.push(`only ${live?.brokers_connected ?? 0}/${live?.brokers_total ?? 0} brokers connected`);
  }
  const malformed = Number(decodeT.malformed ?? 0);
  const pktTotal = Object.values(decodeT).reduce((a, b) => a + b, 0);
  if (pktTotal > 0 && malformed / pktTotal > 0.1) {
    warnings.push(`${Math.round((malformed / pktTotal) * 100)}% of packets are malformed (>10%): decode may be broken`);
  }
  if (rxTotal > 0 && Number(presence?.pct_with_rssi ?? 0) === 0) {
    warnings.push("no reception has rx_rssi: RF metadata is missing entirely, so nothing can be classified as a real RF reception");
  }
  if (rxTotal > 0 && !classT.rf_direct && !classT.rf_direct_low_conf && !classT.rf_relayed) {
    warnings.push("no RF-class receptions at all: everything is MQTT-side, so coverage and distance analytics will be empty");
  }
  // A master-key mismatch invalidates every stored secret at once, and each one now degrades to
  // "unset" instead of throwing (which used to take ingest down in a restart loop). That keeps the
  // install alive but silent, so name the affected values here: a channel key reading as unset
  // makes its traffic undecodable, and a broker password reading as unset stops it connecting.
  // Who, if anyone, currently owns the station node's single-client TCP session. An operator seeing
  // the RF-node chip drop needs to be able to tell a deliberate handoff from a fault.
  const nodeLease = await safe("station-node lease", () => nodeLeaseHolder(), null);

  const badSecrets = await safe("stored secrets", () => undecryptableSecrets(), [] as string[]);
  if (badSecrets.length > 0) {
    warnings.push(
      `${badSecrets.length} stored secret(s) cannot be decrypted with the current master key (${badSecrets.join(", ")}): HOPWATCH_MASTER_KEY / HOPWATCH_SESSION_SECRET changed. Re-enter these values in /admin/settings; until then they read as unset.`,
    );
  }

  const sentish = nOrNull(txConf?.sent_or_better) ?? 0;
  const heard = nOrNull(txConf?.heard_back) ?? 0;
  if (sentish >= 5 && heard === 0) {
    warnings.push(`${sentish} transmits recorded as sent but none were heard back: the mesh is likely not receiving them (check the broker topic root and that a downlink-enabled gateway exists)`);
  }

  return {
    generated_at: new Date().toISOString(),
    window_hours: W,
    version,
    liveness: {
      brokers_total: nOrNull(live?.brokers_total),
      brokers_connected: nOrNull(live?.brokers_connected),
      last_reception_age_sec: nOrNull(live?.last_reception_age_sec),
      last_tx_log_age_sec: nOrNull(live?.last_tx_log_age_sec),
      node_lease_holder: nodeLease ? `${nodeLease.holder}: ${nodeLease.reason}` : null,
    },
    ingest: {
      by_hour: pivotHours(ingestRows.map((r) => ({ hour: r.hour, k: r.k, n: r.n }))),
      by_broker: totalsOf(ingestBroker),
      totals: totalsOf(ingestTotals),
    },
    decode: { by_hour: pivotHours(decodeRows.map((r) => ({ hour: r.hour, k: r.k, n: r.n }))), totals: decodeT },
    classification: { by_hour: pivotHours(classRows.map((r) => ({ hour: r.hour, k: r.k, n: r.n }))), totals: classT },
    field_presence: {
      receptions: rxTotal,
      pct_with_rssi: nOrNull(presence?.pct_with_rssi),
      pct_with_snr: nOrNull(presence?.pct_with_snr),
      pct_with_hop_start: nOrNull(presence?.pct_with_hop_start),
      pct_with_relay_node: nOrNull(presence?.pct_with_relay_node),
    },
    ports: ports.map((p) => ({ port_num: p.port_num === null ? null : Number(p.port_num), port_count: Number(p.port_count) })),
    tx: {
      by_state: totalsOf(txStates),
      confirmations: {
        sent_or_better: nOrNull(txConf?.sent_or_better),
        heard_back: nOrNull(txConf?.heard_back),
        acked: nOrNull(txConf?.acked),
        failed: nOrNull(txConf?.failed),
        dry_run: nOrNull(txConf?.dry_run),
      },
      log_tail: txLog,
    },
    bridge: { forwards_by_direction: totalsOf(bridgeRows), patched: Number(patched?.n ?? 0) },
    secrets: { undecryptable: badSecrets },
    warnings,
  };
}
