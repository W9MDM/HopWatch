import type { ResultSetHeader } from "mysql2";
import { getPool, query, clampLimit } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import type { TxKind } from "../meshtastic/encode.ts";
import type { TxState } from "../lib/txstate.ts";

// TX debug log: a DB-backed trace of the send pipeline so operators without shell access can see
// exactly what the worker did (gating, encode, transport, publish, success/failure) in the UI.
export interface TxLogRow { id: number; created_at: string; outbox_id: number | null; level: string; message: string }

/** Append a TX debug line (also mirrored to stdout). Never throws: logging must not break a send. */
export async function txLog(message: string, opts: { outboxId?: number | null; level?: "info" | "warn" | "error" } = {}): Promise<void> {
  const level = opts.level ?? "info";
  console.log(`[tx]${opts.outboxId ? ` #${opts.outboxId}` : ""} ${message}`);
  try {
    await query(`INSERT INTO tx_log (created_at, outbox_id, level, message) VALUES (?,?,?,?)`,
      [toMysqlUtc(new Date()), opts.outboxId ?? null, level, message.slice(0, 500)]);
  } catch { /* table may not exist yet on first boot; the console line still lands */ }
}

/** Most-recent TX debug lines, newest first. */
export function listTxLog(limit = 100): Promise<TxLogRow[]> {
  return query<TxLogRow>(`SELECT id, created_at, outbox_id, level, message FROM tx_log ORDER BY id DESC LIMIT ${clampLimit(limit, 500)}`);
}

/** Bound the debug log; called from worker maintenance. */
export async function trimTxLog(days = 3): Promise<void> {
  await query(`DELETE FROM tx_log WHERE created_at < (UTC_TIMESTAMP() - INTERVAL ? DAY)`, [days]);
}

export interface OutboxRow {
  id: number; created_at: string; created_by: string; transport: "mqtt" | "node"; broker_id: string | null;
  kind: TxKind; channel_id: string | null; to_node: number | null; from_node: number;
  payload_text: string | null; packet_id: number | null; hop_limit: number; want_ack: number;
  state: TxState; attempts: number; last_attempt_at: string | null; sent_at: string | null; error: string | null;
}

// Read columns exclude the `encoded` blob so it is never shipped to clients or held in memory.
const COLS =
  "id, created_at, created_by, transport, broker_id, kind, channel_id, to_node, from_node, payload_text, packet_id, hop_limit, want_ack, state, attempts, last_attempt_at, sent_at, error";

export interface EnqueueInput {
  createdBy: string; transport?: "mqtt" | "node"; brokerId?: string | null; kind: TxKind;
  channelId?: string | null; toNode?: number | null; fromNode: number;
  payloadText?: string | null; hopLimit: number; wantAck: boolean;
}

export async function enqueueTx(i: EnqueueInput): Promise<number> {
  const now = toMysqlUtc(new Date());
  const [res] = await getPool().execute(
    `INSERT INTO tx_outbox
       (created_at, created_by, transport, broker_id, kind, channel_id, to_node, from_node, payload_text, hop_limit, want_ack, state)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'queued')`,
    [now, i.createdBy, i.transport ?? "mqtt", i.brokerId || null, i.kind, i.channelId ?? null, i.toNode ?? null, i.fromNode,
     i.payloadText ?? null, i.hopLimit, i.wantAck ? 1 : 0],
  );
  const id = (res as ResultSetHeader).insertId;
  await emitTxState(id, "queued", { kind: i.kind, to: i.toNode ?? null, channel: i.channelId ?? null });
  return id;
}

/** Count of rows still waiting to send (queued or held). Proactive enqueuers back off when this
 * is high so they never outrun the outbox drain rate and pile up a backlog. */
export async function outboxBacklog(): Promise<number> {
  const rows = await query<{ c: number }>(`SELECT COUNT(*) c FROM tx_outbox WHERE state IN ('queued','held')`);
  return Number(rows[0]?.c ?? 0);
}

/** True if any traceroute is still waiting to send (so auto-traceroute never stacks another). */
export async function tracerouteQueued(): Promise<boolean> {
  const rows = await query<{ c: number }>(`SELECT COUNT(*) c FROM tx_outbox WHERE kind = 'traceroute' AND state IN ('queued','held')`);
  return Number(rows[0]?.c ?? 0) > 0;
}

/** Epoch ms of the last auto-traceroute we enqueued, or 0, for the send-cadence throttle. */
export async function lastAutoTracerouteMs(): Promise<number> {
  const rows = await query<{ c: string | null }>(`SELECT MAX(created_at) c FROM tx_outbox WHERE created_by = 'auto-traceroute'`);
  return rows[0]?.c ? new Date(rows[0].c.replace(" ", "T") + "Z").getTime() : 0;
}

/**
 * Atomically claim a row for sending: queued/held -> sending. Returns true only if THIS caller won
 * the row, so an overlapping worker tick (or a second worker) can never transmit the same row
 * twice. A `sending` row is invisible to listPendingTx and to cancelOutbox (which only touches
 * queued/held), so it cannot be re-picked or cancel-resurrected mid-flight.
 */
export async function claimForSend(id: number): Promise<boolean> {
  const [res] = await getPool().execute(
    `UPDATE tx_outbox SET state='sending', last_attempt_at=? WHERE id=? AND state IN ('queued','held')`,
    [toMysqlUtc(new Date()), id],
  );
  return (res as ResultSetHeader).affectedRows === 1;
}

/**
 * On worker startup, fail any row left in `sending` by a crash mid-transmit. Conservative on
 * purpose: we cannot know if the packet actually hit the air, and re-sending would double airtime,
 * so we mark it failed (visible, requeueable) rather than auto-resend. Returns rows reconciled.
 */
export async function failInterruptedSends(): Promise<number> {
  const [res] = await getPool().execute(
    `UPDATE tx_outbox SET state='failed', error='interrupted by worker restart mid-send' WHERE state='sending'`,
  );
  return (res as ResultSetHeader).affectedRows;
}

/** Rows awaiting transmission (queued or held by a guard), oldest first. */
export function listPendingTx(limit = 50): Promise<OutboxRow[]> {
  return query<OutboxRow>(
    `SELECT ${COLS} FROM tx_outbox WHERE state IN ('queued','held') ORDER BY id ASC LIMIT ${clampLimit(limit, 500)}`,
  );
}

/** Send timestamps (ms) within the last hour, for the rate limiter. */
export async function recentSentAtMs(): Promise<number[]> {
  const rows = await query<{ sent_at: string }>(
    `SELECT sent_at FROM tx_outbox
     WHERE sent_at IS NOT NULL AND state IN ('sent','heard','acked','dry_run')
       AND sent_at >= (UTC_TIMESTAMP() - INTERVAL 1 HOUR)`,
  );
  return rows.map((r) => new Date(r.sent_at.replace(" ", "T") + "Z").getTime());
}

// Patch is a loose column map so callers can also set the `encoded` blob (not a read column).
export async function updateOutbox(id: number, patch: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  const set = cols.map((c) => `${c} = ?`).join(", ");
  await query(`UPDATE tx_outbox SET ${set} WHERE id = ?`, [...cols.map((c) => patch[c]), id]);
}

export async function setState(id: number, state: TxState, extra: Record<string, unknown> = {}): Promise<void> {
  await updateOutbox(id, { state, ...extra });
  await emitTxState(id, state, {});
}

/** Rows we have sent and are still watching for delivery confirmation. */
export function watchable(): Promise<OutboxRow[]> {
  return query<OutboxRow>(
    `SELECT ${COLS} FROM tx_outbox WHERE state IN ('sent','heard')
       AND sent_at >= (UTC_TIMESTAMP() - INTERVAL 30 MINUTE) AND packet_id IS NOT NULL`,
  );
}

/**
 * Distinct gateways that heard our transmitted packet back (implicit ACK), matched on the
 * mesh packet id + our from-node in the receptions model.
 */
export async function heardBy(packetId: number, fromNode: number): Promise<{ gatewayId: number; heardAt: string }[]> {
  return query<{ gatewayId: number; heardAt: string }>(
    `SELECT r.gateway_id AS gatewayId, MIN(r.rx_time) AS heardAt
     FROM packets p JOIN receptions r ON r.packet_id = p.id
     WHERE p.mesh_packet_id = ? AND p.from_node_id = ?
     GROUP BY r.gateway_id`,
    [packetId, fromNode],
  );
}

/**
 * The ROUTING_APP answer to ONE of our packets, correlated by Data.request_id.
 *
 * This used to ask only "was any port-5 packet addressed to our node since this row was sent". Every
 * in-flight row shares the same from_node (ours), so the query was identical for all of them: one
 * node acking one DM promoted EVERY in-flight row to 'acked', including messages to other nodes that
 * were never delivered. And Routing carries failures as well as acks, so a NAK (NO_ROUTE,
 * MAX_RETRANSMIT, NO_RESPONSE, RATE_LIMIT_EXCEEDED...), i.e. proof of failed delivery, was counted
 * as success. Returns null when nothing has answered yet.
 */
export async function routingAnswer(packetId: number): Promise<{ acked: boolean; errorName: string | null } | null> {
  const rows = await query<{ error_code: number; error_name: string | null }>(
    `SELECT error_code, error_name FROM routing_ack WHERE request_id = ?
     ORDER BY (error_code = 0) DESC, observed_at ASC LIMIT 1`,
    [packetId >>> 0],
  );
  const r = rows[0];
  if (!r) return null;
  return { acked: Number(r.error_code) === 0, errorName: r.error_name };
}

export async function recordConfirmation(outboxId: number, gatewayId: number, heardAt: string, isRoutingAck: boolean): Promise<void> {
  await query(
    `INSERT INTO tx_confirmations (outbox_id, gateway_id, heard_at, is_routing_ack) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE heard_at = VALUES(heard_at), is_routing_ack = tx_confirmations.is_routing_ack OR VALUES(is_routing_ack)`,
    [outboxId, gatewayId, heardAt, isRoutingAck ? 1 : 0],
  );
}

export function confirmationsFor(outboxId: number): Promise<{ gateway_id: number; heard_at: string; is_routing_ack: number }[]> {
  return query(`SELECT gateway_id, heard_at, is_routing_ack FROM tx_confirmations WHERE outbox_id = ? ORDER BY heard_at`, [outboxId]);
}

export function listOutbox(limit = 100): Promise<OutboxRow[]> {
  return query<OutboxRow>(`SELECT ${COLS} FROM tx_outbox ORDER BY id DESC LIMIT ${clampLimit(limit, 500)}`);
}

export async function getOutbox(id: number): Promise<OutboxRow | null> {
  const rows = await query<OutboxRow>(`SELECT ${COLS} FROM tx_outbox WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

/** Cancel a row that has not been sent yet. Returns true if it was cancellable. */
export async function cancelOutbox(id: number): Promise<boolean> {
  const [res] = await getPool().execute(
    `UPDATE tx_outbox SET state = 'cancelled' WHERE id = ? AND state IN ('queued','held')`,
    [id],
  );
  const ok = (res as ResultSetHeader).affectedRows > 0;
  if (ok) await emitTxState(id, "cancelled", {});
  return ok;
}

/** Emit an SSE tx_state event so clients can watch queue progress live. */
export async function emitTxState(id: number, state: string, extra: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO live_events (created_at, event_type, payload) VALUES (?, 'tx_state', ?)`,
    [toMysqlUtc(new Date()), JSON.stringify({ id, state, ...extra })],
  ).catch(() => {});
}

export interface TxThreadRow {
  id: number; created_at: string; sent_at: string | null; channel_id: string | null;
  to_node: number | null; from_node: number; payload_text: string | null; state: TxState; created_by: string;
}

/** Our sent/queued text + DM rows, for merging into the message thread (origin: hopwatch). */
export function txThreadMessages(limit = 200, channelId?: string, q?: string): Promise<TxThreadRow[]> {
  const params: unknown[] = [];
  let where = "kind IN ('text','dm')";
  if (channelId) { where += " AND channel_id = ?"; params.push(channelId); }
  const term = q?.trim();
  if (term) { where += " AND payload_text LIKE ?"; params.push(`%${term}%`); }
  return query<TxThreadRow>(
    `SELECT id, created_at, sent_at, channel_id, to_node, from_node, payload_text, state, created_by
     FROM tx_outbox WHERE ${where} ORDER BY id DESC LIMIT ${clampLimit(limit, 500)}`,
    params,
  );
}

/** Traceroute cooldown: was a traceroute to this node queued within the window? */
export async function tracerouteRecentlyQueued(toNode: number, withinSeconds: number): Promise<boolean> {
  const rows = await query<{ c: number }>(
    `SELECT COUNT(*) c FROM tx_outbox WHERE kind = 'traceroute' AND to_node = ?
       AND created_at >= (UTC_TIMESTAMP() - INTERVAL ? SECOND)`,
    [toNode, withinSeconds],
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

export interface SentTraceroute {
  id: number; to_node: number | null; name: string | null; transport: "mqtt" | "node";
  state: string; created_at: string; sent_at: string | null; attempts: number; error: string | null;
}

/** Recent traceroute sends (outbox), for the traceroutes page "sent" log. */
export function listSentTraceroutes(limit = 50): Promise<SentTraceroute[]> {
  return query<SentTraceroute>(
    `SELECT o.id, o.to_node, COALESCE(n.long_name, n.short_name) AS name, o.transport, o.state,
            o.created_at, o.sent_at, o.attempts, o.error
     FROM tx_outbox o LEFT JOIN nodes n ON n.node_id = o.to_node
     WHERE o.kind = 'traceroute' ORDER BY o.id DESC LIMIT ${clampLimit(limit, 200)}`,
  );
}
