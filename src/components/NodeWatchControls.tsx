"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface WatchState { favorite: boolean; note: string; tags: string[]; alert_offline: boolean }

// Per-user watchlist controls on the node page: star, private note, tags, and an
// offline-alert subscription. Hidden entirely for anonymous visitors.
export function NodeWatchControls({ nodeId }: { nodeId: number }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [s, setS] = useState<WatchState>({ favorite: false, note: "", tags: [], alert_offline: false });
  const [tagInput, setTagInput] = useState("");
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await fetch(`/api/v1/watchlist?node_id=${nodeId}`);
      if (r.status === 401) { setSignedIn(false); return; }
      setSignedIn(true);
      if (r.ok) { const d = await r.json(); if (d.node) setS({ favorite: !!d.node.favorite, note: d.node.note ?? "", tags: d.node.tags ?? [], alert_offline: !!d.node.alert_offline }); }
    })();
  }, [nodeId]);

  async function save(next: WatchState) {
    setS(next);
    const r = await fetch("/api/v1/watchlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node_id: nodeId, ...next }) });
    if (r.ok) { setSaved(true); setTimeout(() => setSaved(false), 1200); }
  }

  if (signedIn !== true) return null;

  const addTag = () => {
    const t = tagInput.trim();
    if (!t || s.tags.includes(t)) { setTagInput(""); return; }
    save({ ...s, tags: [...s.tags, t] }); setTagInput("");
  };

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="eyebrow"><span className="eyebrow-bar" />Watchlist</span>
        <button
          className={`btn h-8 px-3 text-[13px] ${s.favorite ? "btn-primary" : "btn-outline"}`}
          onClick={() => save({ ...s, favorite: !s.favorite })}
        >
          {s.favorite ? "★ Starred" : "☆ Star this node"}
        </button>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={s.alert_offline} onChange={(e) => save({ ...s, alert_offline: e.target.checked })} /> Alert me if it goes offline
        </label>
        <button className="text-[12px] text-accent hover:underline" onClick={() => setOpen((v) => !v)}>{open ? "Hide notes/tags" : "Notes & tags"}</button>
        <Link className="text-[12px] text-ink-mute hover:text-ink" href="/watchlist">My watchlist</Link>
        {saved && <span className="text-[12px] text-ok">Saved</span>}
      </div>

      {open && (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="block stat-label">Private note</span>
            <textarea value={s.note} onChange={(e) => setS({ ...s, note: e.target.value })} onBlur={() => save(s)} placeholder="Only you can see this" className="h-20 w-full rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] text-ink focus:border-accent focus:outline-none" />
          </label>
          <div>
            <span className="block stat-label mb-1">Tags</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {s.tags.map((t) => (
                <span key={t} className="flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 text-[12px] text-ink-mute">
                  {t}<button className="text-ink-faint hover:text-accent-strong" onClick={() => save({ ...s, tags: s.tags.filter((x) => x !== t) })}>&times;</button>
                </span>
              ))}
              <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} placeholder="add tag + Enter" className="h-7 w-32 rounded-md border border-line bg-raised px-2 text-[12px] text-ink focus:border-accent focus:outline-none" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
