"use client";

import { useState } from "react";

// Compose box for the Messages view. Channels are limited to those with a known key (only
// those can be encrypted for TX). Sending queues into the outbox; the chip reflects the
// returned state. Rendered only when tx is enabled.
export function MessageCompose({ channels, dryRun, canned = [] }: { channels: string[]; dryRun: boolean; canned?: string[] }) {
  const [channel, setChannel] = useState(channels[0] ?? "");
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setNote(null); setError(null); setBusy(true);
    try {
      const r = await fetch("/api/v1/tx/message", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, text }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { setNote(`Queued as #${j.id}${dryRun ? " (dry-run: nothing published)" : ""}.`); setText(""); }
      else setError(j.error ?? `failed (${r.status})`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between">
        <span className="eyebrow"><span className="eyebrow-bar" />Send to channel</span>
        {dryRun && <span className="text-[11px] text-accent-strong">dry-run on: nothing is published</span>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <select className="h-9 rounded-md border border-line bg-raised px-2 text-[13px] text-ink" value={channel} onChange={(e) => setChannel(e.target.value)}>
          {channels.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          className="h-9 min-w-[16rem] flex-1 rounded-md border border-line bg-raised px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          placeholder="message (max 228 bytes)"
          value={text}
          maxLength={228}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim() && !busy) void send(); }}
        />
        <button className="btn btn-primary h-9 px-4 text-[13px]" disabled={busy || !text.trim() || !channel} onClick={() => void send()}>Send</button>
      </div>
      {canned.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {canned.map((c) => (
            <button key={c} type="button" className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => setText(c)} title="Insert canned message">{c.length > 32 ? c.slice(0, 31) + "…" : c}</button>
          ))}
        </div>
      )}
      {note && <p className="text-[12px] text-ok">{note}</p>}
      {error && <p className="text-[12px] text-accent-strong">{error}</p>}
    </div>
  );
}
