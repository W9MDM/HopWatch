"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { receptionClassMeta } from "../lib/rx.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { portName } from "../meshtastic/portnum.ts";
import { subscribeLiveEvent, subscribeLiveState } from "../lib/livesse.ts";

interface LiveReception {
  // The wire field is `packetId` (src/ingest/pipeline.ts builds the payload, src/lib/livemap.ts
  // declares the type). Reading it as `id` made every React key undefined, so React fell back to
  // index reconciliation on a list that is mutated by PREPENDING: the worst case, re-rendering all
  // 200 rows on every reception event, with a console warning per render.
  packetId: number;
  from: number;
  gateway: number;
  port: number | null;
  class: string;
  rssi: number | null;
  snr: number | null;
  rxTime: string;
}

// Live packet feed over SSE (spec §: live views, visible pause state). The server
// route tails the live_events table; no heavy query runs per tick.
export function LiveFeed() {
  const [rows, setRows] = useState<LiveReception[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    // Shared connection: the dashboard mounts this alongside LiveMessages, and each component
    // opening its own EventSource used two of the browser's six per-origin connections per tab.
    const offState = subscribeLiveState(setConnected);
    const off = subscribeLiveEvent("reception", (data) => {
      if (pausedRef.current) return;
      // One packet can arrive once per gateway, so the packet id alone is not unique in this list;
      // the key is the reception identity (packet + gateway + rx time), which is what uq_rx is.
      setRows((prev) => [data as LiveReception, ...prev].slice(0, 200));
    });
    return () => { off(); offState(); };
  }, []);

  return (
    <div className="card flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="eyebrow">
          <span className="eyebrow-bar" />
          Live feed
        </h2>
        <div className="flex items-center gap-2">
          <span className={cn("pill", connected ? "pill-on" : "pill-off")}>
            {connected ? "streaming" : "offline"}
          </span>
          <button
            className={cn("btn btn-outline h-8 px-3 text-[13px]")}
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
          >
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ minHeight: 320 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Age</th>
              <th>From</th>
              <th>Gateway</th>
              <th>Port</th>
              <th>Class</th>
              <th className="text-right">RSSI</th>
              <th className="text-right">SNR</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-ink-faint">
                  {paused ? "Paused." : "Waiting for receptions."}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const m = receptionClassMeta(r.class);
              return (
                <tr key={`${r.packetId}-${r.gateway}-${r.rxTime}`}>
                  <td className="text-ink-faint">now</td>
                  <td className="mono">{formatNodeId(r.from)}</td>
                  <td className="mono text-ink-mute">{formatNodeId(r.gateway)}</td>
                  <td className="text-ink-mute">{portName(r.port)}</td>
                  <td className={m.text}>
                    <span className={cn("mr-1 inline-block h-2 w-2 rounded-full align-middle", m.dot)} />
                    {m.label}
                  </td>
                  <td className="text-right tabular-nums">{r.rssi ?? "-"}</td>
                  <td className="text-right tabular-nums">{r.snr ?? "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
