"use client";

import { useState } from "react";
import Link from "next/link";

export interface RegistrySettings {
  announce: {
    enabled: boolean;
    hub_url: string;
    name: string;
    public_url: string;
    interval_minutes: number;
  };
  hub: {
    enabled: boolean;
    stale_days: number;
  };
}

const inputCls = "h-9 w-full rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";
const numCls = "h-9 w-28 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

export function RegistryManager({ initial }: { initial: RegistrySettings }) {
  const [s, setS] = useState<RegistrySettings>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setA = (k: keyof RegistrySettings["announce"], v: unknown) => setS({ ...s, announce: { ...s.announce, [k]: v } });
  const setH = (k: keyof RegistrySettings["hub"], v: unknown) => setS({ ...s, hub: { ...s.hub, [k]: v } });

  async function save() {
    setMsg(null);
    setError(null);
    const res = await fetch("/api/v1/admin/registry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(s),
    });
    if (res.ok) setMsg("Saved. The worker and web pick up the change within about 5 seconds.");
    else setError((await res.json().catch(() => ({}))).error ?? "save failed");
  }

  return (
    <section className="card space-y-5">
      <div>
        <h2 className="eyebrow"><span className="eyebrow-bar" />Instance registry</h2>
        <p className="mt-1 text-[12px] text-ink-faint">
          An opt-in directory of HopWatch deployments. Announcing sends a small heartbeat (name,
          public URL, version) over HTTP, never the mesh, and no node data, telemetry, or secrets.
          Both sides are off by default.
        </p>
      </div>

      {/* Announce side */}
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={s.announce.enabled} onChange={(e) => setA("enabled", e.target.checked)} />
          Announce this instance to a hub
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="block stat-label">Hub URL</span>
            <input className={inputCls} value={s.announce.hub_url} onChange={(e) => setA("hub_url", e.target.value)} placeholder="https://hopwatch.example.com" />
            <span className="block text-[11px] text-ink-faint">where to report (no trailing slash needed)</span>
          </label>
          <label className="space-y-1">
            <span className="block stat-label">Heartbeat interval (min)</span>
            <input className={numCls} type="number" min="1" value={String(s.announce.interval_minutes)} onChange={(e) => setA("interval_minutes", Number(e.target.value))} />
            <span className="block text-[11px] text-ink-faint">how often this instance reports (default 360 = 6h)</span>
          </label>
          <label className="space-y-1">
            <span className="block stat-label">Display name</span>
            <input className={inputCls} value={s.announce.name} onChange={(e) => setA("name", e.target.value)} placeholder="(falls back to brand name)" />
          </label>
          <label className="space-y-1">
            <span className="block stat-label">Public URL</span>
            <input className={inputCls} value={s.announce.public_url} onChange={(e) => setA("public_url", e.target.value)} placeholder="(falls back to server public URL)" />
          </label>
        </div>
      </div>

      {/* Hub side */}
      <div className="space-y-3 border-t border-line pt-4">
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={s.hub.enabled} onChange={(e) => setH("enabled", e.target.checked)} />
          Act as a hub (accept heartbeats + show the directory)
        </label>
        <label className="space-y-1">
          <span className="block stat-label">Directory staleness (days)</span>
          <input className={numCls} type="number" min="0" value={String(s.hub.stale_days)} onChange={(e) => setH("stale_days", Number(e.target.value))} />
          <span className="block text-[11px] text-ink-faint">hide instances not heard from in this many days (0 = never)</span>
        </label>
        <p className="text-[12px] text-ink-faint">
          View received instances on the <Link className="text-accent hover:underline" href="/admin/instances">directory page</Link>.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {error && <span className="text-[12px] text-accent-strong">{error}</span>}
      </div>
    </section>
  );
}
