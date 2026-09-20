"use client";

import { useRef, useState } from "react";

// Backup & restore of the admin-configured settings (overrides + brokers + channel keys + forward
// rules). Download is a plain authenticated GET (the browser sends the session cookie); restore
// uploads a saved file and replaces the current configuration.
export function ConfigBackupManager() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function restore(file: File) {
    setMsg(null); setErr(null);
    let payload: unknown;
    try { payload = JSON.parse(await file.text()); }
    catch { setErr("that file is not valid JSON"); return; }
    if (!confirm("Restore configuration from this file? This REPLACES the current settings, brokers, channel keys and forwarding rules. Operational data (packets, nodes) is untouched.")) return;
    setBusy(true);
    try {
      const r = await fetch("/api/v1/admin/config-backup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        const x = d.result ?? {};
        setMsg(`Restored: ${x.brokers ?? 0} broker(s), ${x.channel_keys ?? 0} channel key(s), ${x.forward_rules ?? 0} forward rule(s), and all settings. Ingest/worker reload within ~5s.`);
      } else setErr(d.error ?? "restore failed");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="eyebrow"><span className="eyebrow-bar" />Backup &amp; restore</h2>
        <p className="mt-1 text-[13px] text-ink-faint">
          Save your configuration (settings, brokers, channel keys, forwarding rules) to a file, or restore it on a
          fresh install after a rebuild. Secrets are exported <b className="text-ink-mute">encrypted</b>, so a restore
          only works on an install with the same master key. This does not include operational data (packets, nodes,
          telemetry) or login accounts.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <a className="btn btn-primary h-9 px-4 text-[13px]" href="/api/v1/admin/config-backup" download>Download backup</a>
        <button className="btn btn-outline h-9 px-4 text-[13px]" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Restoring..." : "Restore from file"}</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void restore(f); }}
        />
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {err && <span className="text-[12px] text-accent-strong">{err}</span>}
      </div>
    </section>
  );
}
