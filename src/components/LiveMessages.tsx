"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "../lib/cn.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { subscribeLiveEvent, subscribeLiveState } from "../lib/livesse.ts";

interface Msg { id: number; observed_at: string; from_node_id: number; from_name: string | null; channel_id: string | null; body: string }

function age(iso: string): string {
  const s = (Date.now() - new Date(iso.replace(" ", "T") + "Z").getTime()) / 1000;
  if (s < 60) return `${Math.max(0, Math.floor(s))}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Recent text messages, refreshed live: reloads when the SSE stream reports a text reception
// (port 1), so new messages appear without polling on a fixed timer.
export function LiveMessages() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/v1/messages?limit=40")
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d) => { if (alive) setMsgs(d.messages ?? []); })
      .catch(() => { /* ignore */ });
    load();

    const offState = subscribeLiveState(setConnected);
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeLiveEvent("reception", (data) => {
      const d = data as { port: number | null };
      if (d.port === 1) { if (t) clearTimeout(t); t = setTimeout(load, 800); } // debounce refetch
    });
    return () => { alive = false; off(); offState(); if (t) clearTimeout(t); };
  }, []);

  return (
    <div className="card flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Live messages</h2>
        <span className={cn("pill", connected ? "pill-on" : "pill-off")}>{connected ? "streaming" : "offline"}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto" style={{ minHeight: 200 }}>
        {msgs.length === 0 && <p className="text-[13px] text-ink-faint">No text messages observed yet.</p>}
        {msgs.map((m) => (
          <div key={m.id} className="border-b border-line pb-2 last:border-0">
            <div className="flex items-center justify-between gap-2 text-[11px] text-ink-faint">
              <Link className="callsign truncate" href={`/nodes/${m.from_node_id}`}>{m.from_name ?? formatNodeId(m.from_node_id)}</Link>
              <span className="flex-none">{m.channel_id ? `${m.channel_id} · ` : ""}{age(m.observed_at)}</span>
            </div>
            <div className="whitespace-pre-wrap break-words text-[13px] text-ink">{m.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
