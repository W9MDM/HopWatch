// In-memory presence for the navbar "online" chip: each open tab beacons every ~30s and the
// chip shows how many distinct tabs beaconed within the window. This is web-process-local UI
// state, not cross-process state (Rule 5 governs ingest/worker/web sharing; nothing here
// leaves the web process), so it needs no table and costs no DB writes. Bounded per best
// practice: expired ids are pruned on every touch and new ids are refused over the cap.

const WINDOW_MS = 90_000;
const MAX_ENTRIES = 5_000;
const seen = new Map<string, number>();

/** Record a heartbeat for one tab id and return how many tabs are currently active. */
export function touchPresence(id: string, now = Date.now()): number {
  for (const [k, t] of seen) if (now - t > WINDOW_MS) seen.delete(k);
  if (seen.has(id) || seen.size < MAX_ENTRIES) seen.set(id, now);
  return seen.size;
}
