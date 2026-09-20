"use client";

import { useState } from "react";
import Link from "next/link";

interface Row {
  node_id: number;
  long_name: string | null;
  short_name: string | null;
  first_seen_at: string;
  reviewed_at: string | null;
  spam_score: number | null;
  best_status: string | null;
  first_gateway: number | null;
}

function fmtNodeId(n: number): string {
  return "!" + (n >>> 0).toString(16).padStart(8, "0");
}

// New-node review queue. Each first-heard node shows how it arrived (direct vs
// relayed), which gateway heard it first, and its talker rate. Admins acknowledge.
export function NewNodeFeed({ initial, isAdmin }: { initial: Row[]; isAdmin: boolean }) {
  const [rows, setRows] = useState(initial);
  const [hideReviewed, setHideReviewed] = useState(true);

  async function review(id: number) {
    const res = await fetch(`/api/v1/admin/nodes/${id}/review`, { method: "POST" });
    if (res.ok) setRows((prev) => prev.map((r) => (r.node_id === id ? { ...r, reviewed_at: new Date().toISOString() } : r)));
  }

  const shown = hideReviewed ? rows.filter((r) => !r.reviewed_at) : rows;

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-[13px] text-ink-mute">
        <input type="checkbox" checked={hideReviewed} onChange={(e) => setHideReviewed(e.target.checked)} />
        Hide reviewed
      </label>
      <div className="space-y-2">
        {shown.length === 0 && <div className="card text-ink-faint">No new nodes to review.</div>}
        {shown.map((r) => (
          <div key={r.node_id} className="card flex flex-wrap items-center gap-3 py-3">
            <Link className="callsign" href={`/nodes/${r.node_id}`}>
              {r.long_name ?? r.short_name ?? fmtNodeId(r.node_id)}
            </Link>
            <span className="mono text-[11px] text-ink-faint">{fmtNodeId(r.node_id)}</span>
            {r.best_status && (
              <span className={r.best_status === "direct" ? "text-rx-direct" : "text-rx-relayed"}>
                first heard {r.best_status}
              </span>
            )}
            {r.first_gateway != null && (
              <span className="text-[11px] text-ink-faint">via {fmtNodeId(r.first_gateway)}</span>
            )}
            {r.spam_score != null && r.spam_score > 0 && (
              <span className="text-[11px] text-ink-faint">{r.spam_score.toFixed(1)} rx/hr</span>
            )}
            <span className="ml-auto text-[11px] text-ink-faint">{new Date(r.first_seen_at.replace(" ", "T") + "Z").toLocaleString()}</span>
            {r.reviewed_at ? (
              <span className="pill pill-on">reviewed</span>
            ) : isAdmin ? (
              <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => review(r.node_id)}>
                Acknowledge
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
