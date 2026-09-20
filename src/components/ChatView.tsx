"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// MeshMonitor-style chat view: a per-channel message thread with our own sent messages shown as
// outgoing bubbles carrying ack status (queued -> sent -> heard -> delivered). Polls the thread
// API every few seconds so acks land without a full reload. Sending queues into the outbox; the
// worker enforces every TX rail, so a bubble only advances past "queued" once it actually goes.

interface ChatItem {
  key: string; timeMs: number; time: string; origin: "rx" | "tx";
  fromNodeId: number | null; fromName: string; channel: string | null; body: string;
  toNode?: number | null; state?: string;
}

// State -> how the outgoing bubble reads. Single check = entered the mesh; double check = our own
// packet was heard back through gateways (implicit ack) or a routing ack landed (delivered).
const ACK: Record<string, { label: string; cls: string; mark: string }> = {
  queued: { label: "queued", cls: "text-ink-faint", mark: "⧖" },
  held: { label: "held (channel busy)", cls: "text-accent-strong", mark: "⧖" },
  dry_run: { label: "dry-run (not sent)", cls: "text-ink-faint", mark: "◌" },
  sent: { label: "sent to mesh", cls: "text-ink-mute", mark: "✓" },
  heard: { label: "heard back", cls: "text-ok", mark: "✓✓" },
  acked: { label: "delivered", cls: "text-ok", mark: "✓✓" },
  failed: { label: "failed", cls: "text-accent-strong", mark: "✗" },
  cancelled: { label: "cancelled", cls: "text-ink-faint", mark: "✗" },
};

export function ChatView({
  channels, initialChannel, zone, txEnabled, dryRun, keyedChannels, canned,
}: {
  channels: string[]; initialChannel: string; zone: string; txEnabled: boolean;
  dryRun: boolean; keyedChannels: string[]; canned: string[];
}) {
  const [channel, setChannel] = useState(initialChannel);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);

  const fmt = useCallback(
    (t: string) => {
      const d = new Date(t.replace(" ", "T") + "Z");
      return new Intl.DateTimeFormat(undefined, { timeZone: zone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
    },
    [zone],
  );

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/messages/thread?channel=${encodeURIComponent(channel)}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(j.items)) setItems(j.items);
    } finally {
      setLoading(false);
    }
  }, [channel]);

  useEffect(() => {
    setLoading(true);
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  // Keep pinned to the newest message unless the user has scrolled up to read history.
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true); setNote(null); setErr(null);
    try {
      const r = await fetch("/api/v1/tx/message", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, text: text.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { setText(""); atBottom.current = true; await load(); if (dryRun) setNote("Queued (dry-run: nothing is published)."); }
      else setErr(j.error ?? `failed (${r.status})`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canSend = txEnabled && keyedChannels.includes(channel);
  const ordered = [...items].reverse(); // oldest -> newest for a chat timeline

  return (
    <div className="card flex h-[70vh] flex-col p-0">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        {channels.length === 0 && <span className="text-[13px] text-ink-faint">No channels seen yet.</span>}
        {channels.map((c) => (
          <button
            key={c}
            onClick={() => { atBottom.current = true; setChannel(c); }}
            className={`h-7 rounded-full px-3 text-[12px] ${c === channel ? "bg-accent/20 text-accent-strong font-semibold" : "text-ink-mute hover:bg-raised"}`}
          >
            {c}
          </button>
        ))}
      </div>

      <div ref={scroller} onScroll={onScroll} className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {loading && items.length === 0 && <p className="text-[13px] text-ink-faint">Loading...</p>}
        {!loading && ordered.length === 0 && <p className="text-[13px] text-ink-faint">No messages on {channel} yet.</p>}
        {ordered.map((m) => {
          const mine = m.origin === "tx";
          const ack = mine && m.state ? ACK[m.state] : null;
          return (
            <div key={m.key} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[78%] rounded-2xl px-3 py-1.5 text-[13px] ${mine ? "bg-accent/15 text-ink" : "bg-raised text-ink"}`}>
                {!mine && <div className="mb-0.5 text-[11px] font-semibold text-accent-strong">{m.fromName}</div>}
                {mine && m.toNode != null && <div className="mb-0.5 text-[11px] text-ink-faint">DM</div>}
                <div className="whitespace-pre-wrap break-words">{m.body}</div>
                <div className={`mt-0.5 flex items-center gap-1.5 text-[10px] ${mine ? "justify-end" : ""} text-ink-faint`}>
                  <span>{fmt(m.time)}</span>
                  {ack && <span className={ack.cls} title={ack.label}>{ack.mark} {ack.label}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-line px-3 py-2">
        {canned.length > 0 && canSend && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {canned.map((c) => (
              <button key={c} type="button" className="btn btn-outline h-6 px-2 text-[11px]" onClick={() => setText(c)}>
                {c.length > 28 ? c.slice(0, 27) + "…" : c}
              </button>
            ))}
          </div>
        )}
        {canSend ? (
          <div className="flex items-end gap-2">
            <input
              className="h-9 flex-1 rounded-md border border-line bg-raised px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
              placeholder={`Message ${channel} (max 228 bytes)${dryRun ? " - dry-run on" : ""}`}
              value={text}
              maxLength={228}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            />
            <button className="btn btn-primary h-9 px-4 text-[13px]" disabled={busy || !text.trim()} onClick={() => void send()}>Send</button>
          </div>
        ) : (
          <p className="text-[12px] text-ink-faint">
            {txEnabled ? `Sending needs a known key for ${channel}.` : "Read-only: sending requires TX to be enabled and a role with transmit permission."}
          </p>
        )}
        {note && <p className="mt-1 text-[12px] text-ok">{note}</p>}
        {err && <p className="mt-1 text-[12px] text-accent-strong">{err}</p>}
      </div>
    </div>
  );
}
