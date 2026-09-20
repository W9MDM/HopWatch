import { query } from "../db/client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { enqueueTx } from "../db/tx.ts";
import type { HopWatchConfig } from "../config/schema.ts";

interface Automation {
  id: string; enabled: boolean; kind: "daily" | "interval"; at: string; every_minutes: number;
  transport: "mqtt" | "rf"; channel: string; template: string;
}

interface MeshStats { count: number; total: number; gateways: number; packets: number; msgs: number }

/**
 * Fire scheduled automations. Each due automation renders its template with live mesh stats and
 * is enqueued to the tx_outbox as our own node (RF or MQTT), so it goes out only when the TX
 * subsystem is enabled + armed and passes every TX rail + audit. "Due" is tracked via the
 * outbox created_by marker so a restart never double-fires: daily fires once per local day at/after
 * its time, interval fires at most once per every_minutes.
 */
export async function runAutomations(cfg: HopWatchConfig): Promise<number> {
  const tx = cfg.tx;
  if (!tx.enabled || !tx.armed || tx.from_node <= 0) return 0;
  const autos = (cfg.automations as Automation[]).filter((a) => a.enabled && a.id && a.template.trim());
  if (autos.length === 0) return 0;

  const zone = cfg.server.local_timezone;
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  const localHM = `${hh}:${mm}`;

  let stats: MeshStats | null = null; // fetched lazily, only if something is due
  let fired = 0;
  for (const a of autos) {
    if (!(await isDue(a, localHM, zone, now))) continue;
    if (!stats) stats = await meshStats();
    const text = render(a.template, stats, cfg, zone);
    await enqueueTx({
      createdBy: `automation:${a.id}`, transport: a.transport === "rf" ? "node" : "mqtt", kind: "text",
      channelId: a.channel || null, toNode: null, fromNode: tx.from_node,
      payloadText: text.slice(0, 220), hopLimit: tx.default_hop_limit, wantAck: false,
    });
    fired++;
  }
  if (fired) console.log(`[worker] fired ${fired} automation(s)`);
  return fired;
}

async function isDue(a: Automation, localHM: string, zone: string, now: Date): Promise<boolean> {
  const marker = `automation:${a.id}`;
  if (a.kind === "interval") {
    const [r] = await query<{ c: number }>(
      `SELECT COUNT(*) c FROM tx_outbox WHERE created_by=? AND created_at >= (UTC_TIMESTAMP() - INTERVAL ? SECOND)`,
      [marker, Math.max(1, a.every_minutes) * 60],
    );
    return Number(r?.c ?? 0) === 0;
  }
  // daily: at/after the target time, and not already fired since local midnight.
  if (localHM < (a.at || "09:00")) return false;
  const midnightUtc = localMidnightUtc(zone, now);
  const [r] = await query<{ c: number }>(
    `SELECT COUNT(*) c FROM tx_outbox WHERE created_by=? AND created_at >= ?`,
    [marker, toMysqlUtc(midnightUtc)],
  );
  return Number(r?.c ?? 0) === 0;
}

function localMidnightUtc(zone: string, now: Date): Date {
  try {
    const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-").map(Number);
    const utcNow = new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    const locNow = new Date(now.toLocaleString("en-US", { timeZone: zone })).getTime();
    return new Date(Date.UTC(y!, m! - 1, d!, 0, 0, 0) - (locNow - utcNow));
  } catch {
    return new Date(now.getTime() - 24 * 3600 * 1000);
  }
}

async function meshStats(): Promise<MeshStats> {
  const [[a], [t], [g], [p], [msg]] = await Promise.all([
    query<{ c: number }>(`SELECT COUNT(DISTINCT from_node_id) c FROM receptions WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`),
    query<{ c: number }>(`SELECT COUNT(*) c FROM nodes`),
    query<{ c: number }>(`SELECT COUNT(*) c FROM gateways WHERE active=1`),
    query<{ c: number }>(`SELECT COUNT(DISTINCT packet_id) c FROM receptions WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`),
    query<{ c: number }>(`SELECT COUNT(*) c FROM text_message WHERE observed_at >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`),
  ]);
  return { count: Number(a?.c ?? 0), total: Number(t?.c ?? 0), gateways: Number(g?.c ?? 0), packets: Number(p?.c ?? 0), msgs: Number(msg?.c ?? 0) };
}

function render(tpl: string, s: MeshStats, cfg: HopWatchConfig, zone: string): string {
  const now = new Date();
  const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit" }).format(now);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" }).format(now);
  const map: Record<string, string> = {
    count: String(s.count), total: String(s.total), gateways: String(s.gateways),
    packets: String(s.packets), msgs: String(s.msgs), time, date, brand: cfg.server.ui.brand_name || "HopWatch",
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in map ? map[k]! : m));
}
