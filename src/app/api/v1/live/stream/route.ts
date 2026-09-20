import type { NextRequest } from "next/server";
import { requireModule } from "../../../../../auth/rbac.ts";
import { subscribeLive, liveCursor } from "../../../../../lib/livehub.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SSE stream fed by a single process-level tailer (see lib/livehub.ts) so M viewers do not each
// poll the DB. This connection just fans the shared events into its own stream, with per-connection
// backpressure so one slow client cannot grow memory unbounded.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "livemap");
  if (denied) return denied;
  const encoder = new TextEncoder();

  // Declared out here so `cancel` can reach it: the underlying source is torn down through cancel()
  // as well as through the request's abort signal, and either may come first.
  let close = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let behindSince = 0;
      let unsubscribe: (() => void) | null = null;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      const SATURATION_MS = 30_000;

      // Teardown is defined and REGISTERED before the first await. It used to be wired only after
      // `await subscribeLive(...)`, which itself awaits a pool acquisition plus a DB round trip. A
      // client that aborted inside that window (a navigation right after load, a reload, a crawler)
      // left an already-aborted signal, and per DOM semantics an already-aborted signal never fires
      // a listener added afterwards. So `close` never ran: the subscriber stayed in the hub forever,
      // the 25s keepalive interval ran forever, and because the hub stops polling only when it has
      // no subscribers, the shared 1s live_events poll never stopped either.
      close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (keepalive) clearInterval(keepalive);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", close);
      if (req.signal.aborted) return close();

      // Per-connection backpressure: if this client's buffer is full, drop (do not enqueue) and
      // close it after sustained saturation, without affecting other subscribers.
      const send = (event: string, data: unknown) => {
        if (closed) return;
        if ((controller.desiredSize ?? 1) <= 0) {
          if (!behindSince) behindSince = Date.now();
          else if (Date.now() - behindSince > SATURATION_MS) close();
          return;
        }
        behindSince = 0;
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
      };

      send("hello", { cursor: liveCursor() });
      unsubscribe = await subscribeLive(send);
      // The abort may have landed during that await, in which case close() already ran and the
      // subscription it could not see must be released now.
      if (closed) return unsubscribe();

      keepalive = setInterval(() => { if (!closed) try { controller.enqueue(encoder.encode(`: keepalive\n\n`)); } catch { /* closed */ } }, 25_000);
    },
    // Reached when the consumer tears the stream down without an abort event.
    cancel() { close(); },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
