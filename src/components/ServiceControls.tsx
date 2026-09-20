"use client";

import { useEffect, useState } from "react";

interface UpdateStatus { enabled?: boolean; update_available?: boolean; current?: string; latest?: string | null; url?: string | null; error?: string }

// Admin control to restart the background processes, or update the whole install, without
// shell access. Restart posts a DB request the target process sees on its next poll (it exits
// and systemd relaunches it). Update posts a DB request the hopwatch-update timer claims on
// its next tick: it pulls the latest code, rebuilds the web app, and restarts all services.
// On mount it also checks GitHub for a newer release and, if one exists, prompts with a pill.
export function ServiceControls() {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [upd, setUpd] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/v1/admin/service/update-check")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setUpd(j); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

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
    const to = upd?.update_available && upd.latest ? ` to v${upd.latest}` : "";
    if (!confirm(`Update HopWatch now${to}? The updater pulls the latest code, rebuilds, and restarts all services (a few minutes of downtime).`)) return;
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

  const available = !!upd?.update_available;

  return (
    <div className="flex items-center gap-2">
      {note && <span className="text-[11px] text-ink-faint">{note}</span>}
      {available && (
        <a
          href={upd?.url ?? "#"} target="_blank" rel="noopener noreferrer"
          className="rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent-strong"
          title={`Running v${upd?.current}; v${upd?.latest} is available. Opens the release notes; use "Update now" to install.`}
        >
          Update available: v{upd?.latest}
        </a>
      )}
      <button className="btn btn-outline h-7 px-2 text-[12px]" disabled={busy === "worker"} onClick={() => void restart("worker")} title="Restart the worker (rollups, TX outbox, automations). Use after deploying new code.">
        {busy === "worker" ? "Restarting..." : "Restart worker"}
      </button>
      <button className="btn btn-outline h-7 px-2 text-[12px]" disabled={busy === "ingest"} onClick={() => void restart("ingest")} title="Restart the ingest daemon (MQTT + RF receive). Use after deploying new code.">
        {busy === "ingest" ? "Restarting..." : "Restart ingest"}
      </button>
      <button className={`btn h-7 px-2 text-[12px] ${available ? "btn-primary" : "btn-outline"}`} disabled={busy === "update"} onClick={() => void updateNow()} title="Pull the latest code from git, rebuild the web app, and restart all services. Needs the hopwatch-update timer installed (see deploy/systemd).">
        {busy === "update" ? "Requesting..." : "Update now"}
      </button>
    </div>
  );
}
