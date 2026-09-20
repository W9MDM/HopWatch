"use client";

import { useEffect, useRef, useState } from "react";
import { subscribeLiveEvent, subscribeLiveState } from "../lib/livesse.ts";
import { portName } from "../meshtastic/portnum.ts";
import { formatNodeId } from "../meshtastic/types.ts";

interface Row { key: string; from: number; gateway: number; rssi: number | null; snr: number | null; hops: number | null; port: number | null; t: number }

// Live ticker of packets from the given node(s), off the shared SSE stream. Each row is one reception
// (a gateway hearing the node right now) with its signal and hop count, so the reach page shows the
// node actually reaching the mesh in real time. Multi-node aware (the fleet page passes all its ids).
export function LivePackets({ nodeIds, names = {}, showFrom = false, max = 18 }: {
  nodeIds: number[];
  names?: Record<number, string>;
  showFrom?: boolean;
  max?: number;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [live, setLive] = useState(false);
  const ids = useRef(new Set(nodeIds.map((n) => n >>> 0)));
  ids.current = new Set(nodeIds.map((n) => n >>> 0));
  const seq = useRef(0);

  useEffect(() => {
    const offState = subscribeLiveState(setLive);
    const offRx = subscribeLiveEvent("reception", (data) => {
      const d = data as { packetId: number; from: number; gateway: number; rssi: number | null; snr: number | null; hopStart: number | null; hopLimit: number | null; port: number | null };
      if (typeof d?.from !== "number" || !ids.current.has(d.from >>> 0)) return;
      const hops = d.hopStart != null && d.hopLimit != null ? d.hopStart - d.hopLimit : null;
      const row: Row = { key: `${d.packetId}-${d.gateway}-${seq.current++}`, from: d.from, gateway: d.gateway, rssi: d.rssi, snr: d.snr, hops, port: d.port, t: Date.now() };
      setRows((prev) => [row, ...prev].slice(0, max));
    });
    return () => { offState(); offRx(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour12: false });

  return (
    <section className="card space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Live activity</h2>
        <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <span className={`inline-block h-2 w-2 rounded-full ${live ? "bg-ok" : "bg-ink-faint"}`} />
          {live ? "live" : "connecting"}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-ink-faint">Waiting for a packet from {showFrom ? "your nodes" : "this node"} to be heard live. Quiet nodes may take a while.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="data text-[12px]">
            <thead><tr><th>Time</th>{showFrom && <th>Node</th>}<th>Heard by</th><th>Type</th><th className="text-right">Signal</th><th className="text-right">Hops</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="tabular-nums text-ink-faint">{clock(r.t)}</td>
                  {showFrom && <td className="mono">{names[r.from] ?? formatNodeId(r.from)}</td>}
                  <td className="mono text-ink-mute">{formatNodeId(r.gateway)}</td>
                  <td className="text-ink-mute">{portName(r.port ?? undefined) ?? "-"}</td>
                  <td className="text-right tabular-nums">{r.rssi != null ? `${r.rssi} dBm` : "-"}{r.snr != null ? ` / ${r.snr.toFixed(1)} dB` : ""}</td>
                  <td className="text-right tabular-nums">{r.hops == null ? "-" : r.hops === 0 ? <span className="text-ok">direct</span> : r.hops}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
