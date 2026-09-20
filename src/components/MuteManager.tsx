"use client";

import { useState } from "react";

interface MutedRow {
  node_id: number;
  reason: string | null;
  added_by: string | null;
  added_at: string;
  source: string;
}

function fmtNodeId(n: number): string {
  return "!" + (n >>> 0).toString(16).padStart(8, "0");
}

export function MuteManager({ initial }: { initial: MutedRow[] }) {
  const [rows, setRows] = useState<MutedRow[]>(initial);
  const [nodeId, setNodeId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/v1/admin/mute-list");
    if (res.ok) setRows((await res.json()).mute_list);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/v1/admin/mute-list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: nodeId, reason }),
    });
    if (res.ok) {
      setNodeId("");
      setReason("");
      await refresh();
    } else {
      setError((await res.json().catch(() => ({}))).error ?? "failed");
    }
  }

  async function remove(id: number) {
    const res = await fetch(`/api/v1/admin/mute-list?node_id=${id}`, { method: "DELETE" });
    if (res.ok) await refresh();
  }

  return (
    <div className="space-y-4">
      <form className="card flex flex-wrap items-end gap-3" onSubmit={add}>
        <label className="space-y-1.5">
          <span className="block stat-label">Node id</span>
          <input
            value={nodeId}
            onChange={(e) => setNodeId(e.target.value)}
            placeholder="!aabbccdd or number"
            className="h-9 w-44 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex-1 space-y-1.5">
          <span className="block stat-label">Reason</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="why is this node muted"
            className="h-9 w-full rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none"
          />
        </label>
        <button className="btn btn-primary h-9 px-4 text-[13px]" type="submit">
          Mute node
        </button>
      </form>
      {error && <p className="text-xs text-accent-strong">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Node</th>
              <th>Reason</th>
              <th>By</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="text-ink-faint">
                  No muted nodes.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.node_id}>
                <td className="mono">{fmtNodeId(r.node_id)}</td>
                <td className="text-ink-mute">{r.reason ?? "-"}</td>
                <td className="text-ink-faint">{r.added_by ?? "-"}</td>
                <td className="text-ink-faint">{r.source}</td>
                <td className="text-right">
                  <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => remove(r.node_id)}>
                    Unmute
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
