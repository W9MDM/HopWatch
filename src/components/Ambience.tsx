"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { portName } from "../meshtastic/portnum.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { subscribeLiveEvent } from "../lib/livesse.ts";

interface LiveReception {
  from: number;
  gateway: number;
  port: number | null;
  class: string;
  rssi: number | null;
  snr: number | null;
}

const WAVES: OscillatorType[] = ["sine", "triangle", "square", "sawtooth"];

// Pitch from RSSI, timbre (oscillator wave) from port number. Pure client audio over
// the existing SSE stream; no server cost beyond the stream (spec §: ambience mode).
function rssiToFreq(rssi: number | null): number {
  const r = rssi ?? -100;
  const clamped = Math.max(-120, Math.min(-30, r));
  const t = (clamped + 120) / 90; // 0..1
  return 200 + t * 1000; // 200..1200 Hz
}

export function Ambience() {
  const [on, setOn] = useState(false);
  const [count, setCount] = useState(0);
  const [recent, setRecent] = useState<LiveReception[]>([]);
  const ctxRef = useRef<AudioContext | null>(null);
  const onRef = useRef(on);
  onRef.current = on;

  useEffect(() => {
    const off = subscribeLiveEvent("reception", (data) => {
      if (!onRef.current) return;
      const d = data as LiveReception;
      beep(d);
      setCount((c) => c + 1);
      setRecent((prev) => [d, ...prev].slice(0, 12));
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function beep(d: LiveReception) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = WAVES[(d.port ?? 0) % WAVES.length]!;
    osc.frequency.value = rssiToFreq(d.rssi);
    const peak = 0.12 + Math.min(0.12, Math.max(0, ((d.snr ?? 0) + 5) / 100));
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  function toggle() {
    if (!on) {
      // AudioContext must be created/resumed from a user gesture.
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      if (!ctxRef.current) ctxRef.current = new Ctor();
      void ctxRef.current.resume();
    }
    setOn((v) => !v);
  }

  return (
    <div className="space-y-4">
      <div className="card flex items-center justify-between">
        <div>
          <div className="stat-label">Receptions sonified</div>
          <div className="stat mt-1">{count}</div>
        </div>
        <button className={cn("btn h-10 px-5", on ? "btn-primary" : "btn-outline")} onClick={toggle}>
          {on ? "Stop" : "Start"} ambience
        </button>
      </div>
      <p className="text-[13px] text-ink-faint">
        Each reception plays a short tone. Pitch rises with RSSI; the waveform is chosen by port
        number. Audio runs entirely in your browser over the live stream.
      </p>
      <div className="card">
        <h2 className="eyebrow mb-2">
          <span className="eyebrow-bar" />
          Recent
        </h2>
        <ul className="space-y-1 text-[13px]">
          {recent.length === 0 && <li className="text-ink-faint">{on ? "Listening…" : "Press start."}</li>}
          {recent.map((r, i) => (
            <li key={i} className="flex items-center gap-3">
              <span className="mono text-ink">{formatNodeId(r.from)}</span>
              <span className="text-ink-mute">{portName(r.port)}</span>
              <span className="ml-auto tabular-nums text-ink-faint">
                {r.rssi ?? "-"} dBm · {Math.round(rssiToFreq(r.rssi))} Hz
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
