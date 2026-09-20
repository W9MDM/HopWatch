"use client";

import { useEffect, useState } from "react";

interface RfState { host: string; rx_enabled: boolean; connected: number; last_message_at: string | null }

function age(ts: string | null): string {
  if (!ts) return "";
  const then = new Date(ts.replace(" ", "T") + "Z").getTime();
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Navbar RF-node chip. Server seeds the initial state (no flash); this then polls so the operator
// actually sees it flip between connected / down as the station node comes and goes, instead of a
// value frozen at page-load time. Hidden entirely when no station node is configured.
export function RfNodeChip({ initial }: { initial: RfState }) {
  const [s, setS] = useState<RfState>(initial);

  useEffect(() => {
    const pull = async () => {
      try {
        const r = await fetch("/api/v1/node-rx", { cache: "no-store" });
        if (r.ok) setS(await r.json());
      } catch { /* keep last known */ }
    };
    void pull();
    const t = setInterval(() => void pull(), 10_000);
    return () => clearInterval(t);
  }, []);

  if (!s.host) return null;
  const state = !s.rx_enabled ? "off" : s.connected ? "up" : "down";
  const tone = state === "up" ? "text-ok" : state === "down" ? "text-accent-strong" : "text-ink-faint";
  const dot = state === "up" ? "bg-ok" : state === "down" ? "bg-accent-strong" : "bg-ink-faint";
  const label = state === "up" ? "node" : state === "down" ? "down" : "off";
  const title = state === "up" ? `RF node connected${s.last_message_at ? ` - last RF packet ${age(s.last_message_at)} ago` : ""}`
    : state === "down" ? "RF node RX enabled but not connected (reconnecting)"
    : "RF receive disabled (enable node.rx_enabled to ingest RF)";

  return (
    <span className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px]" title={title}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      <span className="hidden text-ink-faint sm:inline">RF</span>
      <span className={`font-medium ${tone}`}>{label}</span>
    </span>
  );
}
