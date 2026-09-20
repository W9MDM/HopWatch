// Pure decision logic for the TX outbox: rate limiting, channel-util guard, retry backoff,
// state promotion on delivery confirmation, and implicit-ACK matching. No DB, no clock of
// its own (callers pass `now`), so every rule is unit-testable.

export type TxState = "queued" | "held" | "sending" | "dry_run" | "sent" | "heard" | "acked" | "failed" | "cancelled";

/** True if another send is allowed given recent send timestamps and the per-min/hr caps. */
export function rateAllowed(sentAtMs: number[], now: number, perMinute: number, perHour: number): boolean {
  const inMinute = sentAtMs.filter((t) => now - t < 60_000).length;
  const inHour = sentAtMs.filter((t) => now - t < 3_600_000).length;
  return inMinute < perMinute && inHour < perHour;
}

/** Channel-util guard: unknown util never blocks; otherwise it must be at or below the cap. */
export function channelUtilOk(util: number | null | undefined, maxUtil: number): boolean {
  if (util === null || util === undefined) return true;
  return util <= maxUtil;
}

/** Exponential backoff (5s, 15s, 45s, ...) capped at 10 minutes. attempts is 1-based. */
export function backoffMs(attempts: number): number {
  const base = 5000 * Math.pow(3, Math.max(0, attempts - 1));
  return Math.min(base, 600_000);
}

/** State after a send attempt: dry-run publishes nothing, everything else becomes 'sent'. */
export function sentState(dryRun: boolean): TxState {
  return dryRun ? "dry_run" : "sent";
}

export interface ConfirmationSignal {
  gatewayCount: number; // distinct gateways that heard our packet back
  routingAck: boolean; // an explicit ROUTING_APP ack addressed to us
}

/**
 * Promote an outbox row on new confirmation evidence. A routing ack wins (acked); otherwise
 * being heard by >=1 gateway is 'heard'. Terminal/never-sent states are left untouched, and
 * 'acked' is never downgraded.
 */
export function promote(current: TxState, sig: ConfirmationSignal): TxState {
  if (current === "cancelled" || current === "failed" || current === "queued" || current === "held" || current === "dry_run") {
    return current;
  }
  if (sig.routingAck) return "acked";
  if (current === "acked") return "acked";
  if (sig.gatewayCount >= 1) return "heard";
  return current;
}

export interface OutboxKey {
  packetId: number;
  fromNode: number;
  sentAtMs: number;
}
export interface IncomingReception {
  packetId: number;
  fromNode: number;
  rxAtMs: number;
}

/**
 * Implicit ACK: an incoming reception confirms our outbox row only when BOTH the packet id
 * and the source node match what we transmitted, within the confirmation window. A foreign
 * packet that merely collides on packet id (different from-node) is not a confirmation.
 */
export function isConfirmation(o: OutboxKey, r: IncomingReception, windowMs = 15 * 60_000): boolean {
  if (r.packetId !== o.packetId || r.fromNode !== o.fromNode) return false;
  const dt = r.rxAtMs - o.sentAtMs;
  return dt >= -1000 && dt <= windowMs; // allow ~1s clock skew, cap at the window
}
