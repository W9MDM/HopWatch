"use client";

import { useState } from "react";

// Admin control to restart the background processes, or update the whole install, without
// shell access. Restart posts a DB request the target process sees on its next poll (it exits
// and systemd relaunches it). Update posts a DB request the hopwatch-update timer claims on
// its next tick: it pulls the latest code, rebuilds the web app, and restarts all services.
export function ServiceControls() {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function restart(service: "worker" | "ingest") {
    if (!confirm(`Restart the ${service}? It will be unavailable for a few seconds while systemd relaunches it.`)) return;
    setBusy(service); setNote(null);
    try {
      const r = await fetch("/api/v1/admin/service/restart", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service }),
      });
      const j = await r.json().catch(() => ({}));
      setNote(r.ok ? `${service} restart requested; back in ~5-15s.` : (j.error ?? "request failed"));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function updateNow() {
    if (!confirm("Update HopWatch now? The updater pulls the latest code, rebuilds, and restarts all services (a few minutes of downtime).")) return;
    setBusy("update"); setNote(null);
    try {
      const r = await fetch("/api/v1/admin/service/update", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      setNote(r.ok ? "Update requested; the updater picks it up within ~1 min, then rebuilds and restarts." : (j.error ?? "request failed"));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {note && <span className="text-[11px] text-ink-faint">{note}</span>}
      <button className="btn btn-outline h-7 px-2 text-[12px]" disabled={busy === "worker"} onClick={() => void restart("worker")} title="Restart the worker (rollups, TX outbox, automations). Use after deploying new code.">
        {busy === "worker" ? "Restarting..." : "Restart worker"}
      </button>
      <button className="btn btn-outline h-7 px-2 text-[12px]" disabled={busy === "ingest"} onClick={() => void restart("ingest")} title="Restart the ingest daemon (MQTT + RF receive). Use after deploying new code.">
        {busy === "ingest" ? "Restarting..." : "Restart ingest"}
      </button>
      <button className="btn btn-outline h-7 px-2 text-[12px]" disabled={busy === "update"} onClick={() => void updateNow()} title="Pull the latest code from git, rebuild the web app, and restart all services. Needs the hopwatch-update timer installed (see deploy/systemd).">
        {busy === "update" ? "Requesting..." : "Update now"}
      </button>
    </div>
  );
}
