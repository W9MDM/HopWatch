"use client";

import { useEffect, useState } from "react";

// Navbar chip showing how many browser tabs have HopWatch open right now. Each tab beacons
// /api/v1/presence every 30s with a random per-tab id (sessionStorage, no tracking value);
// the server counts ids seen in the last ~90s. Hidden until the first successful beacon,
// so viewers whose role is denied the endpoint simply never see the chip.
export function ViewersChip() {
  const [n, setN] = useState<number | null>(null);

  useEffect(() => {
    let id = "";
    try {
      id = sessionStorage.getItem("hopwatch_tab_id") ?? "";
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem("hopwatch_tab_id", id); }
    } catch { id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }

    let stop = false;
    const beat = async () => {
      try {
        const r = await fetch("/api/v1/presence", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }), cache: "no-store",
        });
        const j = await r.json().catch(() => null);
        if (!stop && r.ok && typeof j?.viewers === "number") setN(j.viewers);
      } catch { /* transient failure: keep the last count */ }
    };
    void beat();
    const t = setInterval(() => void beat(), 30_000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  if (n == null) return null;
  return (
    <span
      className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px]"
      title={`${n} browser tab(s) connected (active in the last 90s)`}
    >
      <span className="inline-block h-2 w-2 rounded-full text-ok" style={{ background: "currentColor" }} />
      <span className="hidden text-ink-faint sm:inline">Online:</span>
      <span className="font-medium text-ink">{n}</span>
    </span>
  );
}
