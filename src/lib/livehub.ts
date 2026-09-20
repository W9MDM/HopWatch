import { liveEventsSince, maxLiveEventId } from "../db/queries.ts";

// Process-level live_events tailer. Every SSE connection used to run its own 1s DB poll, so M
// viewers meant M queries/sec against live_events. This polls ONCE per second for the whole web
// process and fans each event out to all connected subscribers. Reference-counted: the poll only
// runs while at least one subscriber is connected. A single `polling` guard prevents overlapping
// ticks under DB latency (which would otherwise re-read the same cursor and double-send).

type Subscriber = (event: string, payload: unknown) => void;

/**
 * How far BELOW the high-water id each poll re-reads.
 *
 * A plain `id > cursor` tail loses whole batches. InnoDB allocates auto-increment ids at INSERT
 * time, not at commit time, and HopWatch has two independent writer processes. So: ingest opens a
 * transaction and inserts a 200-row batch of live_events taking ids 1000..1199, still uncommitted;
 * the worker sends a TX and its single autocommit emitTxState takes id 1200 and commits at once; the
 * 1s poll sees only 1200 and sets cursor = 1200; ingest commits, and 1000..1199 can now never
 * satisfy `id > 1200`. A whole batch of receptions never reaches /livemap, the live feed or the
 * graph. Re-reading a trailing window and deduping by id catches those late-visible rows. The window
 * only has to cover the largest plausible in-flight allocation (a batch is bounded by maxBatch).
 */
const LOOKBACK_IDS = 2000;

const subs = new Set<Subscriber>();
let cursor = 0;
/** Ids at or below this are never re-queried, so they can never be re-delivered. Seeded to the id
 * at startup so subscribing does not replay history. */
let floorId = 0;
/** Ids already fanned out, within the lookback window. */
let delivered = new Set<number>();
let started = false;
let polling = false;
let timer: NodeJS.Timeout | null = null;

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const from = Math.max(floorId, cursor - LOOKBACK_IDS);
    const events = await liveEventsSince(from, 500);
    for (const e of events) {
      if (e.id <= floorId || delivered.has(e.id)) continue; // already fanned out
      delivered.add(e.id);
      cursor = Math.max(cursor, e.id);
      const payload = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
      for (const s of subs) {
        try { s(e.event_type, payload); } catch { /* one slow/broken subscriber must not stop the fan-out */ }
      }
    }
    // Retire ids that have fallen out of the re-read window, so the set stays bounded.
    const keepAbove = Math.max(floorId, cursor - LOOKBACK_IDS);
    if (delivered.size > LOOKBACK_IDS * 2) {
      delivered = new Set([...delivered].filter((id) => id > keepAbove));
    }
  } catch {
    // Transient DB error: keep subscribers connected, retry next tick.
  } finally {
    polling = false;
  }
}

/** Register an SSE subscriber. Returns an unsubscribe fn; the shared poll stops when the last
 * subscriber leaves. */
export async function subscribeLive(fn: Subscriber): Promise<() => void> {
  if (!started) {
    started = true;
    try { cursor = await maxLiveEventId(); } catch { cursor = 0; }
    // Everything already in the table is history: never replay it, and never re-read below it.
    floorId = cursor;
    delivered = new Set();
  }
  subs.add(fn);
  if (!timer) timer = setInterval(() => void poll(), 1000);
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && timer) { clearInterval(timer); timer = null; started = false; }
  };
}

export function liveCursor(): number {
  return cursor;
}
