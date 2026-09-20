"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface View { path: string; label: string }

// Views worth cycling on a wall display. Each is loaded with ?embed=1 so its app chrome is
// hidden (see KioskChrome + globals.css). Access is still enforced per-page server-side.
const VIEWS: View[] = [
  { path: "/livemap", label: "Live map" },
  { path: "/map", label: "Map" },
  { path: "/coverage", label: "Coverage" },
  { path: "/", label: "Dashboard" },
  { path: "/graph", label: "Graph" },
  { path: "/messages", label: "Messages" },
];

const DUR_KEY = "hopwatch_kiosk_seconds";
const SEL_KEY = "hopwatch_kiosk_views";

export function Kiosk() {
  const [selected, setSelected] = useState<string[]>(VIEWS.map((v) => v.path));
  const [seconds, setSeconds] = useState(20);
  const [playing, setPlaying] = useState(true);
  const [idx, setIdx] = useState(0);
  const [now, setNow] = useState("");
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    try {
      const d = Number(localStorage.getItem(DUR_KEY));
      if (Number.isFinite(d) && d >= 5) setSeconds(d);
      const s = localStorage.getItem(SEL_KEY);
      if (s) { const arr = JSON.parse(s) as string[]; if (Array.isArray(arr) && arr.length) setSelected(arr); }
    } catch { /* ignore */ }
  }, []);

  const active = VIEWS.filter((v) => selected.includes(v.path));
  const current = active[idx % Math.max(1, active.length)] ?? active[0] ?? VIEWS[0];

  // Clock in the overlay. 1s tick, independent of rotation.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toLocaleTimeString()), 1000);
    setNow(new Date().toLocaleTimeString());
    return () => clearInterval(t);
  }, []);

  // Rotation timer.
  useEffect(() => {
    if (!playing || active.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % active.length), seconds * 1000);
    return () => clearInterval(t);
  }, [playing, seconds, active.length]);

  const persistDur = (d: number) => { try { localStorage.setItem(DUR_KEY, String(d)); } catch { /* ignore */ } };
  const persistSel = (s: string[]) => { try { localStorage.setItem(SEL_KEY, JSON.stringify(s)); } catch { /* ignore */ } };

  const toggleView = (path: string) => {
    setSelected((prev) => {
      const next = prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path];
      const ordered = VIEWS.filter((v) => next.includes(v.path)).map((v) => v.path);
      persistSel(ordered);
      return ordered;
    });
    setIdx(0);
  };

  const goFullscreen = useCallback(() => {
    const el = document.getElementById("kiosk-stage");
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => { /* ignore */ });
  }, []);

  const src = current ? `${current.path}${current.path.includes("?") ? "&" : "?"}embed=1` : "/?embed=1";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          Seconds per view
          <input type="number" min={5} max={600} value={String(seconds)} onChange={(e) => { const d = Math.max(5, Number(e.target.value) || 20); setSeconds(d); persistDur(d); }} className="h-9 w-20 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none" />
        </label>
        <button className="btn btn-outline h-9 px-3 text-[13px]" onClick={goFullscreen}>Fullscreen</button>
        <div className="flex flex-wrap items-center gap-2">
          {VIEWS.map((v) => (
            <label key={v.path} className="flex items-center gap-1 text-[12px] text-ink-mute">
              <input type="checkbox" checked={selected.includes(v.path)} onChange={() => toggleView(v.path)} /> {v.label}
            </label>
          ))}
        </div>
      </div>

      <div id="kiosk-stage" className="relative h-[70vh] w-full overflow-hidden rounded-lg border border-line bg-surface">
        <iframe ref={frameRef} src={src} title={current?.label ?? "kiosk"} className="h-full w-full border-0" />
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex items-center justify-between gap-3 bg-gradient-to-t from-black/60 to-transparent px-4 py-2 text-white">
          <span className="text-sm font-semibold">{current?.label}</span>
          <div className="flex items-center gap-1.5">
            {active.map((v, i) => (
              <span key={v.path} className={`inline-block h-1.5 rounded-full transition-all ${i === idx % Math.max(1, active.length) ? "w-6 bg-white" : "w-1.5 bg-white/40"}`} />
            ))}
          </div>
          <span className="tabular-nums text-sm">{now}</span>
        </div>
      </div>
      <p className="text-[12px] text-ink-faint">Cycles the selected views for a wall display. Fullscreen the stage for a clean kiosk; the app header is hidden inside each view.</p>
    </div>
  );
}
