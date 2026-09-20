import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { dispatch, type Channel } from "./delivery.ts";
import type { HopWatchConfig } from "../config/schema.ts";

interface Firing {
  key: string;
  title: string;
  body: string;
}

// Rules that fire once and should not be auto-resolved (there is no "clear" state).
const ONE_SHOT = new Set(["new_node", "spoof_flag"]);

export async function evaluateAlerts(cfg: HopWatchConfig): Promise<number> {
  if (!cfg.alerts.enabled) return 0;
  let fired = 0;
  for (const rule of cfg.alerts.rules) {
    if (!rule.enabled) continue;
    let firing: Firing[] = [];
    try {
      firing = await evaluateRule(rule as AnyRule);
    } catch (e) {
      console.error(`[worker] alert rule ${rule.id} failed: ${(e as Error).message}`);
      continue;
    }
    fired += await reconcile(cfg, rule as AnyRule, firing);
  }
  return fired;
}

type AnyRule = HopWatchConfig["alerts"]["rules"][number] & Record<string, unknown>;

async function reconcile(cfg: HopWatchConfig, rule: AnyRule, firing: Firing[]): Promise<number> {
  const open = await query<{ fired_key: string }>(
    `SELECT fired_key FROM alerts WHERE rule_id=? AND resolved_at IS NULL`,
    [rule.id],
  );
  const openKeys = new Set(open.map((o) => o.fired_key));
  const firingKeys = new Set(firing.map((f) => f.key));

  let delivered = 0;
  for (const f of firing) {
    if (openKeys.has(f.key)) continue; // already active
    const status = await dispatch(rule.channels as Channel[], { title: f.title, body: f.body }, cfg.alerts.delivery);
    await query(
      `INSERT INTO alerts (rule_id, severity, title, body, created_at, fired_key, delivery)
       VALUES (?,?,?,?,?,?,?)`,
      [rule.id, severityFor(rule.type), f.title, f.body, toMysqlUtc(new Date()), f.key, JSON.stringify(status)],
    );
    delivered++;
  }

  if (!ONE_SHOT.has(rule.type)) {
    for (const key of openKeys) {
      if (!firingKeys.has(key)) {
        await query(
          `UPDATE alerts SET resolved_at=? WHERE rule_id=? AND fired_key=? AND resolved_at IS NULL`,
          [toMysqlUtc(new Date()), rule.id, key],
        );
      }
    }
  }
  return delivered;
}

function severityFor(type: string): string {
  if (type === "spoof_flag") return "critical";
  if (type === "battery_threshold" || type === "gateway_silent") return "warn";
  return "info";
}

async function evaluateRule(rule: AnyRule): Promise<Firing[]> {
  switch (rule.type) {
    case "node_offline": {
      const mins = Number(rule.threshold_minutes ?? 60);
      const rows = await query<{ node_id: number; long_name: string | null }>(
        `SELECT node_id, long_name FROM nodes
         WHERE mute_hidden=0 AND last_seen_at IS NOT NULL
           AND last_seen_at < (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
           AND last_seen_at > (UTC_TIMESTAMP() - INTERVAL 7 DAY)`,
        [mins],
      );
      return rows.map((r) => ({
        key: String(r.node_id),
        title: `Node offline: ${label(r.node_id, r.long_name)}`,
        body: `${label(r.node_id, r.long_name)} has not been heard for over ${mins} minutes.`,
      }));
    }
    case "battery_threshold": {
      const volts = Number(rule.threshold_volts ?? 3.3);
      const rows = await query<{ node_id: number; long_name: string | null; value: number }>(
        `SELECT t.node_id, n.long_name, t.value
         FROM node_telemetry t
         JOIN (SELECT node_id, MAX(observed_at) mo FROM node_telemetry
               WHERE metric='voltage' AND observed_at > (UTC_TIMESTAMP() - INTERVAL 1 DAY) GROUP BY node_id) x
           ON x.node_id=t.node_id AND x.mo=t.observed_at
         LEFT JOIN nodes n ON n.node_id=t.node_id
         WHERE t.metric='voltage' AND t.value < ?`,
        [volts],
      );
      return rows.map((r) => ({
        key: String(r.node_id),
        title: `Low battery: ${label(r.node_id, r.long_name)}`,
        body: `Voltage ${r.value.toFixed(2)} V is below ${volts} V.`,
      }));
    }
    case "spoof_flag": {
      const rows = await query<{ flag_id: number; node_id: number; message: string }>(
        `SELECT flag_id, node_id, message FROM node_flags
         WHERE flag_type='spoof_pubkey' AND resolved_at IS NULL`,
      );
      return rows.map((r) => ({
        key: String(r.flag_id),
        title: `Spoof flag: ${formatNodeId(r.node_id)}`,
        body: r.message,
      }));
    }
    case "new_node": {
      const rows = await query<{ node_id: number; long_name: string | null }>(
        `SELECT node_id, long_name FROM nodes WHERE first_seen_at > (UTC_TIMESTAMP() - INTERVAL 1 DAY)`,
      );
      return rows.map((r) => ({
        key: String(r.node_id),
        title: `New node: ${label(r.node_id, r.long_name)}`,
        body: `First heard ${formatNodeId(r.node_id)}.`,
      }));
    }
    case "gateway_silent": {
      const mins = Number(rule.threshold_minutes ?? 30);
      const rows = await query<{ gateway_id: number }>(
        `SELECT gateway_id FROM gateways WHERE active=1 AND last_seen_at IS NOT NULL
           AND last_seen_at < (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
           AND last_seen_at > (UTC_TIMESTAMP() - INTERVAL 7 DAY)`,
        [mins],
      );
      return rows.map((r) => ({
        key: String(r.gateway_id),
        title: `Gateway silent: ${formatNodeId(r.gateway_id)}`,
        body: `Gateway ${formatNodeId(r.gateway_id)} has been silent for over ${mins} minutes.`,
      }));
    }
    case "channel_util": {
      const pct = Number(rule.threshold_pct ?? 40);
      const rows = await query<{ node_id: number; long_name: string | null; value: number }>(
        `SELECT t.node_id, n.long_name, t.value
         FROM node_telemetry t
         JOIN (SELECT node_id, MAX(observed_at) mo FROM node_telemetry
               WHERE metric='chan_util' AND observed_at > (UTC_TIMESTAMP() - INTERVAL 3 HOUR) GROUP BY node_id) x
           ON x.node_id=t.node_id AND x.mo=t.observed_at
         LEFT JOIN nodes n ON n.node_id=t.node_id
         WHERE t.metric='chan_util' AND t.value > ?`,
        [pct],
      );
      return rows.map((r) => ({
        key: String(r.node_id),
        title: `High channel utilization: ${label(r.node_id, r.long_name)}`,
        body: `Channel utilization ${r.value.toFixed(1)}% exceeds ${pct}%.`,
      }));
    }
    case "battery_forecast": {
      const days = Number(rule.days_ahead ?? 5);
      const rows = await query<{ node_id: number; long_name: string | null; projected_dead_at: string }>(
        `SELECT b.node_id, n.long_name, b.projected_dead_at
         FROM battery_forecast b LEFT JOIN nodes n ON n.node_id=b.node_id
         WHERE b.projected_dead_at IS NOT NULL AND b.projected_dead_at <= (UTC_TIMESTAMP() + INTERVAL ? DAY)`,
        [days],
      );
      return rows.map((r) => ({
        key: String(r.node_id),
        title: `Node projected dark: ${label(r.node_id, r.long_name)}`,
        body: `Battery forecast projects ${label(r.node_id, r.long_name)} dead by ${r.projected_dead_at} UTC.`,
      }));
    }
    default:
      return [];
  }
}

function label(id: number, name: string | null): string {
  return name ?? formatNodeId(id);
}
