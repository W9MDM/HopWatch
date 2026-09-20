"use client";

// One SSE connection per browser tab, shared by every live component on the page.
//
// Five components open the live stream (LiveFeed, LiveMessages, LiveMap, MeshGraph, Ambience) and
// the dashboard mounts two of them at once, so each tab held two long-lived streams that never close
// while the page is open. The shipped deployment is Next serving directly over HTTP/1.1 (see
// deploy/systemd/hopwatch-web.service; there is no nginx/TLS/HTTP2 layer anywhere in deploy/), where
// browsers cap concurrent connections at 6 per origin. Three dashboard tabs consumed all six, and
// every further request to the origin (navigation, /api/v1/* fetches, map tiles from the same host)
// stalled until a stream was torn down.
//
// This multiplexes them: the EventSource is reference-counted, created on the first subscriber and
// closed when the last one leaves. Server-side cost drops the same way, since each connection is a
// subscriber on the process-level tailer.

type Handler = (data: unknown) => void;
type StateHandler = (connected: boolean) => void;

const STREAM_URL = "/api/v1/live/stream";

let source: EventSource | null = null;
let refs = 0;
let connected = false;
const handlers = new Map<string, Set<Handler>>();
const stateHandlers = new Set<StateHandler>();
/** Event names the shared source has attached a listener for. */
const attached = new Set<string>();

function setConnected(v: boolean): void {
  connected = v;
  for (const fn of stateHandlers) { try { fn(v); } catch { /* a consumer must not break the fan-out */ } }
}

function attach(event: string): void {
  if (!source || attached.has(event)) return;
  attached.add(event);
  source.addEventListener(event, (e) => {
    let data: unknown;
    try { data = JSON.parse((e as MessageEvent).data); } catch { return; } // malformed frame
    for (const fn of handlers.get(event) ?? []) {
      try { fn(data); } catch { /* one consumer's error must not drop the event for the others */ }
    }
  });
}

function ensureSource(): void {
  if (source) return;
  source = new EventSource(STREAM_URL);
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false);
  // EventSource reconnects on its own, so a listener attached once stays valid across reconnects.
  for (const event of [...handlers.keys()]) { attached.delete(event); attach(event); }
}

function release(): void {
  refs -= 1;
  if (refs > 0) return;
  refs = 0;
  source?.close();
  source = null;
  attached.clear();
  setConnected(false);
}

/**
 * Subscribe to one live event type. Returns an unsubscribe function; call it from the effect's
 * cleanup. The connection is opened on the first subscriber and closed when the last unsubscribes.
 */
export function subscribeLiveEvent(event: string, fn: Handler): () => void {
  let set = handlers.get(event);
  if (!set) { set = new Set(); handlers.set(event, set); }
  set.add(fn);
  refs += 1;
  ensureSource();
  attach(event);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    set!.delete(fn);
    if (set!.size === 0) handlers.delete(event);
    release();
  };
}

/** Observe the shared connection's state. Also counts as a subscriber, so a component that only
 * shows a "streaming" pill keeps the stream open for as long as it is mounted. */
export function subscribeLiveState(fn: StateHandler): () => void {
  stateHandlers.add(fn);
  refs += 1;
  ensureSource();
  fn(connected);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    stateHandlers.delete(fn);
    release();
  };
}
