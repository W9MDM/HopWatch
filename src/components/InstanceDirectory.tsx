"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtAge } from "../lib/format.ts";
import { cn } from "../lib/cn.ts";

export interface DirectoryRow {
  instance_id: string;
  name: string;
  url: string;
  version: string;
  first_seen: string;
  last_seen: string;
  hidden: number;
}

function ageMinutes(ts: string): number {
  return (Date.now() - new Date(ts.replace(" ", "T") + "Z").getTime()) / 60000;
}

export function InstanceDirectory({ rows, staleDays }: { rows: DirectoryRow[]; staleDays: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const staleMin = staleDays > 0 ? staleDays * 1440 : Infinity;

  async function act(id: string, action: "hide" | "unhide" | "delete") {
    if (action === "delete" && !confirm("Remove this instance from the directory? It will reappear if it announces again.")) return;
    setBusy(id);
    await fetch("/api/v1/admin/registry/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action }),
    }).catch(() => {});
    setBusy(null);
    router.refresh();
  }

  if (rows.length === 0) {
    return <p className="text-[13px] text-ink-faint">No instances have announced yet.</p>;
  }

  return (
    <table className="data">
      <thead>
        <tr>
          <th>Name</th>
          <th>URL</th>
          <th>Version</th>
          <th>First seen</th>
          <th>Last seen</th>
          <th className="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const stale = ageMinutes(r.last_seen) > staleMin;
          return (
            <tr key={r.instance_id} className={cn(r.hidden ? "opacity-50" : "")}>
              <td>
                {r.name || <span className="text-ink-faint">(unnamed)</span>}
                {r.hidden ? <span className="pill pill-off ml-2">hidden</span> : null}
                {stale ? <span className="pill ml-2">stale</span> : null}
              </td>
              <td className="mono">
                {r.url ? (
                  <a className="text-accent hover:underline" href={r.url} target="_blank" rel="noopener noreferrer">{r.url.replace(/^https?:\/\//, "")}</a>
                ) : (
                  <span className="text-ink-faint">-</span>
                )}
              </td>
              <td className="mono text-ink-mute">{r.version || "-"}</td>
              <td className="text-ink-mute">{r.first_seen.slice(0, 10)}</td>
              <td className="text-ink-mute">{fmtAge(r.last_seen)}</td>
              <td className="text-right">
                <div className="inline-flex gap-2">
                  <button className="btn h-7 px-2 text-[12px]" disabled={busy === r.instance_id} onClick={() => act(r.instance_id, r.hidden ? "unhide" : "hide")}>
                    {r.hidden ? "Unhide" : "Hide"}
                  </button>
                  <button className="btn h-7 px-2 text-[12px] text-accent-strong" disabled={busy === r.instance_id} onClick={() => act(r.instance_id, "delete")}>
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
