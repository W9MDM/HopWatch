"use client";

import { useState } from "react";
import Link from "next/link";

export interface AutoTracerouteSettings {
  enabled: boolean; send_every_minutes: number; interval_hours: number; max_per_run: number; max_active_age_hours: number;
  transport: "rf" | "mqtt"; only_routers: boolean;
}
export interface TracerouteSettings { traceroute_cooldown_s: number; auto_traceroute: AutoTracerouteSettings }

const inputCls = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

// Traceroute settings tab: the manual-traceroute cooldown plus automatic topology mapping. Patches
// only tx.traceroute_cooldown_s + tx.auto_traceroute via its own endpoint. The sent-traceroute log
// lives on the Traceroutes page.
export function TracerouteSettingsManager({ initial }: { initial: TracerouteSettings }) {
  const [cooldown, setCooldown] = useState(initial.traceroute_cooldown_s);
  const [at, setAt] = useState<AutoTracerouteSettings>(initial.auto_traceroute);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const setA = (patch: Partial<AutoTracerouteSettings>) => setAt({ ...at, ...patch });

  async function save() {
    setMsg(null); setErr(null);
    const r = await fetch("/api/v1/admin/tx/traceroute-settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceroute_cooldown_s: cooldown, auto_traceroute: at }),
    });
    if (r.ok) setMsg("Saved. The worker picks up changes on its next tick.");
    else setErr((await r.json().catch(() => ({}))).error ?? "save failed");
  }

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="eyebrow"><span className="eyebrow-bar" />Traceroutes</h2>
          <p className="mt-1 text-[13px] text-ink-faint">Manual + automatic traceroutes. Sending requires TX enabled + armed + dry-run off.</p>
        </div>
        <Link className="btn btn-outline h-8 px-3 text-[13px]" href="/traceroutes">View traceroute log</Link>
      </div>

      <label className="space-y-1 block max-w-xs"><span className="block stat-label">Manual traceroute cooldown (s)</span>
        <input type="number" value={String(cooldown)} onChange={(e) => setCooldown(Number(e.target.value))} className={inputCls} />
        <span className="block text-[11px] text-ink-faint">Minimum time between traceroutes to the same node (from the node page / API).</span>
      </label>

      <div className="space-y-2 rounded-md border border-line p-3">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={at.enabled} onChange={(e) => setA({ enabled: e.target.checked })} /> Auto-traceroute (map topology efficiently)</label>
        <p className="text-[11px] text-ink-faint">Sends at most one traceroute batch every &quot;send every&quot; minutes, and never while one is still queued (no stacking). Targets only active nodes whose route is missing or stale.</p>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1"><span className="block stat-label">Send a traceroute every (min)</span><input type="number" min={1} value={String(at.send_every_minutes)} onChange={(e) => setA({ send_every_minutes: Number(e.target.value) })} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">Max per batch</span><input type="number" min={1} value={String(at.max_per_run)} onChange={(e) => setA({ max_per_run: Number(e.target.value) })} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">Re-trace interval (h)</span><input type="number" value={String(at.interval_hours)} onChange={(e) => setA({ interval_hours: Number(e.target.value) })} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">Only nodes seen within (h)</span><input type="number" value={String(at.max_active_age_hours)} onChange={(e) => setA({ max_active_age_hours: Number(e.target.value) })} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">Transport</span>
            <select value={at.transport} onChange={(e) => setA({ transport: e.target.value as "rf" | "mqtt" })} className="h-9 rounded-md border border-line bg-raised px-2 text-[13px] text-ink"><option value="rf">RF (station node)</option><option value="mqtt">MQTT downlink</option></select>
          </label>
          <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={at.only_routers} onChange={(e) => setA({ only_routers: e.target.checked })} /> routers/repeaters only</label>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save traceroute settings</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {err && <span className="text-[12px] text-accent-strong">{err}</span>}
      </div>
    </section>
  );
}
