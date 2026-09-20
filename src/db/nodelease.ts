import { randomBytes } from "node:crypto";
import type { ResultSetHeader } from "mysql2";
import { getPool, query } from "./client.ts";

// Cross-process lease on the station node's TCP stream API (see db/migrations/0048_node_lease.sql).
//
// The firmware's API server keeps ONE client: ServerAPI.cpp force-closes the previous session as
// soon as it accepts a new connection. HopWatch opens that port from ingest (the persistent RX
// stream), the worker (every TX publish, plus the channel-index config read) and web (admin config
// read/write), in three separate processes that may only coordinate through the database (Rule 5).
//
// Protocol: a short-lived operation takes the lease, waits a grace period for the RX connector to
// notice and let go, does its work, releases. The RX connector polls the lease and stays down while
// it is held instead of reconnecting into a fight. These timings are an internal handshake, not
// operator-facing behaviour, so they are constants rather than settings.

/** Lease lifetime. Longer than the slowest operation it guards (the 25s config-write handshake), so
 * a holder never loses it mid-flight, and short enough that a crashed holder frees it quickly. */
const TTL_SECONDS = 45;
/** How often a holder pushes `expires_at` out while it is still working. */
export const RENEW_EVERY_MS = 15_000;
/** How long to keep trying before giving up on a busy node. */
const ACQUIRE_TIMEOUT_MS = 30_000;
const ACQUIRE_POLL_MS = 250;
/** Time to let the RX connector observe the lease and close its socket, so the node is idle when we
 * connect. Must exceed the connector's poll interval. Exported so the two stay in step. */
export const HANDOFF_GRACE_MS = 1_200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Take the lease if it is free or expired. Returns the token to renew/release with, or null. */
export async function acquireNodeLease(holder: string, reason: string): Promise<string | null> {
  const token = randomBytes(16).toString("hex");
  // One atomic conditional UPDATE: whoever gets affectedRows == 1 owns the lease. Doing this as a
  // SELECT-then-UPDATE would let two processes both see it free.
  const [res] = await getPool().execute(
    `UPDATE node_lease
        SET token=?, holder=?, reason=?, acquired_at=UTC_TIMESTAMP(3),
            expires_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
      WHERE id=1 AND (expires_at IS NULL OR expires_at <= UTC_TIMESTAMP(3))`,
    [token, holder.slice(0, 32), reason.slice(0, 64), TTL_SECONDS],
  );
  return (res as ResultSetHeader).affectedRows === 1 ? token : null;
}

/** Push the expiry out. False means we no longer hold it (expired and taken by someone else). */
export async function renewNodeLease(token: string): Promise<boolean> {
  const [res] = await getPool().execute(
    `UPDATE node_lease SET expires_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND) WHERE id=1 AND token=?`,
    [TTL_SECONDS, token],
  );
  return (res as ResultSetHeader).affectedRows === 1;
}

/** Free the lease, but only if we still hold it. */
export async function releaseNodeLease(token: string): Promise<void> {
  await query(`UPDATE node_lease SET expires_at=UTC_TIMESTAMP(3), token='' WHERE id=1 AND token=?`, [token]);
}

/** Who holds the lease right now, or null when it is free. Used by the RX connector to decide
 * whether to yield. A missing table (migration not yet run) reads as free, so an un-migrated
 * install behaves exactly as it did before the lease existed rather than refusing to connect. */
export async function nodeLeaseHolder(): Promise<{ holder: string; reason: string } | null> {
  try {
    const rows = await query<{ holder: string; reason: string }>(
      `SELECT holder, reason FROM node_lease WHERE id=1 AND expires_at > UTC_TIMESTAMP(3)`,
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Run `fn` while holding the lease: acquire (waiting for a current holder), let the RX connector
 * stand down, renew in the background, and always release.
 *
 * A lease failure never blocks the operation. If the table is missing or the DB is unreachable we
 * proceed unserialized, which is exactly the pre-lease behaviour; refusing to transmit because a
 * bookkeeping row could not be written would be a worse failure than contending for the socket.
 */
export async function withNodeLease<T>(holder: string, reason: string, fn: () => Promise<T>): Promise<T> {
  let token: string | null = null;
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  try {
    for (;;) {
      token = await acquireNodeLease(holder, reason);
      if (token) break;
      if (Date.now() >= deadline) {
        const held = await nodeLeaseHolder();
        throw new Error(`station node is busy (${held ? `${held.holder}: ${held.reason}` : "lease held"}); try again`);
      }
      await sleep(ACQUIRE_POLL_MS);
    }
  } catch (e) {
    // Distinguish "someone else legitimately holds it" from "the lease is unavailable to us".
    if ((e as Error).message.startsWith("station node is busy")) throw e;
    return fn();
  }

  await sleep(HANDOFF_GRACE_MS);
  const renew = setInterval(() => { void renewNodeLease(token!).catch(() => {}); }, RENEW_EVERY_MS);
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await releaseNodeLease(token).catch(() => {});
  }
}
