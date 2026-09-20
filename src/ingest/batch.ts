import { getPool } from "../db/client.ts";
import { applyEnvelope, insertLiveEvents, processEnvelope, type IngestMeta, type LiveEvt } from "./pipeline.ts";
import type { NormalizedEnvelope } from "../meshtastic/types.ts";

interface Item {
  env: NormalizedEnvelope;
  meta: IngestMeta;
}

// Micro-batches many messages into a single transaction to sustain the regional
// write rate (spec §2). Correctness is unchanged: each message runs the same
// statements via applyEnvelope; only the commit boundary is shared. On a batch
// failure we roll back and retry the items individually so one bad message cannot
// drop a whole batch.
export class BatchIngestor {
  private queue: Item[] = [];
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;
  private dropped = 0;

  constructor(
    private maxBatch = 200,
    private maxDelayMs = 250,
    // Hard OOM backstop: if the DB write rate falls below the MQTT arrival rate (channel storm,
    // slow disk, lock contention), the queue would otherwise grow without bound and crash the
    // process. Over this cap we shed the newest message and count it, so loss is visible in logs
    // rather than a silent OOM.
    private maxQueue = 50_000,
  ) {}

  enqueue(env: NormalizedEnvelope, meta: IngestMeta): void {
    if (this.queue.length >= this.maxQueue) {
      this.dropped++;
      if (this.dropped === 1 || this.dropped % 1000 === 0) {
        console.error(`[ingest] queue full at ${this.queue.length}; dropped ${this.dropped} message(s) - write rate is below arrival rate`);
      }
      return;
    }
    this.queue.push({ env, meta });
    if (this.queue.length >= this.maxBatch) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.maxDelayMs);
    }
  }

  /** Resolves when the in-flight flush finishes, so a caller can wait rather than skip. */
  private inFlight: Promise<void> | null = null;

  /**
   * Drain everything currently queued AND anything queued while draining, waiting for an in-flight
   * flush rather than returning past it.
   *
   * Shutdown calls this, and the old early return made it a no-op whenever a flush was already
   * running: shutdown then closed the pool underneath the still-running loop, so every remaining
   * chunk failed its getConnection(), the individual retry failed too, and each item was logged as
   * "dropped message". With MQTT subscribed at QoS 0 there is no redelivery, so those receptions
   * were simply gone. Up to maxQueue messages per restart.
   */
  async drain(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (this.inFlight) await this.inFlight.catch(() => {});
      if (this.queue.length === 0) return;
      await this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    let settle = () => {};
    this.inFlight = new Promise<void>((r) => { settle = r; });
    const drained = this.queue;
    this.queue = [];

    try {
      // Commit in fixed maxBatch-sized transactions rather than one giant transaction over the
      // whole drained queue: a backlog could otherwise hold tens of thousands of row locks in a
      // single commit (long lock hold, huge undo/redo, all-or-nothing rollback).
      for (let i = 0; i < drained.length; i += this.maxBatch) {
        const chunk = drained.slice(i, i + this.maxBatch);
        const conn = await getPool().getConnection();
        try {
          await conn.beginTransaction();
          const live: LiveEvt[] = [];
          for (const item of chunk) await applyEnvelope(conn, item.env, item.meta, live);
          await insertLiveEvents(conn, live); // one multi-row insert per transaction (P4)
          await conn.commit();
        } catch (e) {
          await conn.rollback().catch(() => {});
          console.error(`[ingest] batch of ${chunk.length} failed, retrying individually: ${(e as Error).message}`);
          for (const item of chunk) {
            try {
              await processEnvelope(item.env, item.meta);
            } catch (err) {
              console.error(`[ingest] dropped message: ${(err as Error).message}`);
            }
          }
        } finally {
          conn.release();
        }
      }
    } finally {
      this.flushing = false;
      this.inFlight = null;
      settle();
      // Anything queued during the flush gets scheduled.
      if (this.queue.length > 0 && !this.timer) {
        this.timer = setTimeout(() => void this.flush(), this.maxDelayMs);
      }
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Total messages shed because the queue hit its cap (0 in normal operation). */
  get droppedTotal(): number {
    return this.dropped;
  }
}
