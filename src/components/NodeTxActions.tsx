"use client";

import { useState } from "react";

// TX actions on the node page: DM, traceroute, and position/telemetry requests. Shown only
// when tx is enabled. Each queues into the outbox; the worker enforces arm state and rails.
export function NodeTxActions({ nodeId, channels, dryRun }: { nodeId: number; channels: string[]; dryRun: boolean }) {
  const [dmOpen, setDmOpen] = useState(false);
  const [channel, setChannel] = useState(channels[0] ?? "");
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(url: string, body: Record<string, unknown>, label: string) {
    setNote(null); setError(null); setBusy(true);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setNote(`${label} queued as #${j.id}${dryRun ? " (dry-run)" : ""}.`);
      else setError(j.error ?? `failed (${r.status})`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow"><span className="eyebrow-bar" />Transmit</span>
        {dryRun && <span className="text-[11px] text-accent-strong">dry-run on</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          <button className="btn btn-outline h-8 px-3 text-[12px]" disabled={busy} onClick={() => setDmOpen((v) => !v)}>DM</button>
          <button className="btn btn-outline h-8 px-3 text-[12px]" disabled={busy} onClick={() => void post("/api/v1/tx/traceroute", { to: nodeId, channel }, "Traceroute")}>Traceroute</button>
          <button className="btn btn-outline h-8 px-3 text-[12px]" disabled={busy} onClick={() => void post("/api/v1/tx/request", { to: nodeId, kind: "position", channel }, "Position request")}>Request position</button>
          <button className="btn btn-outline h-8 px-3 text-[12px]" disabled={busy} onClick={() => void post("/api/v1/tx/request", { to: nodeId, kind: "telemetry", channel }, "Telemetry request")}>Request telemetry</button>
        </div>
      </div>
      {dmOpen && (
        <div className="flex flex-wrap items-end gap-2">
          <select className="h-9 rounded-md border border-line bg-raised px-2 text-[13px] text-ink" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {channels.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input
            className="h-9 min-w-[14rem] flex-1 rounded-md border border-line bg-raised px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            placeholder="direct message (max 228 bytes)" value={text} maxLength={228}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && text.trim() && !busy) void post("/api/v1/tx/message", { to: nodeId, channel, text }, "DM").then(() => setText("")); }}
          />
          <button className="btn btn-primary h-9 px-4 text-[13px]" disabled={busy || !text.trim() || !channel} onClick={() => void post("/api/v1/tx/message", { to: nodeId, channel, text }, "DM").then(() => setText(""))}>Send DM</button>
        </div>
      )}
      {note && <p className="text-[12px] text-ok">{note}</p>}
      {error && <p className="text-[12px] text-accent-strong">{error}</p>}
    </div>
  );
}
