"use client";

import { useState } from "react";

export interface Automation {
  id: string; enabled: boolean; kind: "daily" | "interval"; at: string; every_minutes: number;
  transport: "mqtt" | "rf"; channel: string; template: string;
}

const inp = "h-8 rounded-md border border-line bg-raised px-2 text-[12px] text-ink focus:border-accent focus:outline-none";

// Scheduled automations editor. Each row sends a templated message on a daily time or interval,
// via the armed tx_outbox (RF or MQTT). Template vars: {count} {total} {gateways} {packets}
// {msgs} {time} {date} {brand}.
export function AutomationsManager({ initial }: { initial: Automation[] }) {
  const [rows, setRows] = useState<Automation[]>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const upd = (i: number, patch: Partial<Automation>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => setRows([...rows, { id: `auto-${rows.length + 1}`, enabled: true, kind: "daily", at: "09:00", every_minutes: 60, transport: "mqtt", channel: "", template: "" }]);
  const remove = (i: number) => setRows(rows.filter((_, j) => j !== i));

  async function save() {
    setMsg(null); setErr(null);
    const r = await fetch("/api/v1/admin/automations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ automations: rows }) });
    if (r.ok) setMsg("Saved. The worker fires due automations on its next tick (needs TX enabled + armed).");
    else setErr((await r.json().catch(() => ({}))).error ?? "save failed");
  }

  return (
    <section className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Scheduled automations</h2>
        <button className="btn btn-outline h-8 px-3 text-[13px]" onClick={add}>Add automation</button>
      </div>
      <p className="text-[11px] text-ink-faint">
        Templated messages sent on a schedule as your TX node through the armed outbox (so they need TX enabled + armed).
        Template vars: <span className="mono">{"{count} {total} {gateways} {packets} {msgs} {time} {date} {brand}"}</span>.
      </p>
      {rows.length === 0 && <p className="text-[13px] text-ink-faint">No automations. Add one, e.g. a daily 09:00 LongFast status.</p>}
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="space-y-2 rounded-md border border-line p-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={r.enabled} onChange={(e) => upd(i, { enabled: e.target.checked })} /> on</label>
              <label className="space-y-1"><span className="block stat-label">Id</span><input className={`${inp} w-28`} value={r.id} onChange={(e) => upd(i, { id: e.target.value })} /></label>
              <label className="space-y-1"><span className="block stat-label">Schedule</span>
                <select className={`${inp} w-28`} value={r.kind} onChange={(e) => upd(i, { kind: e.target.value as Automation["kind"] })}><option value="daily">daily</option><option value="interval">interval</option></select>
              </label>
              {r.kind === "daily"
                ? <label className="space-y-1"><span className="block stat-label">At (HH:MM)</span><input className={`${inp} w-20`} value={r.at} onChange={(e) => upd(i, { at: e.target.value })} placeholder="09:00" /></label>
                : <label className="space-y-1"><span className="block stat-label">Every (min)</span><input type="number" className={`${inp} w-20`} value={String(r.every_minutes)} onChange={(e) => upd(i, { every_minutes: Number(e.target.value) })} /></label>}
              <label className="space-y-1"><span className="block stat-label">Transport</span>
                <select className={`${inp} w-24`} value={r.transport} onChange={(e) => upd(i, { transport: e.target.value as Automation["transport"] })}><option value="mqtt">MQTT</option><option value="rf">RF</option></select>
              </label>
              <label className="space-y-1"><span className="block stat-label">Channel</span><input className={`${inp} w-28`} value={r.channel} onChange={(e) => upd(i, { channel: e.target.value })} placeholder="LongFast" /></label>
              <button className="btn btn-outline h-8 px-2 text-[12px]" onClick={() => remove(i)}>remove</button>
            </div>
            <input className={`${inp} w-full`} value={r.template} onChange={(e) => upd(i, { template: e.target.value })} placeholder="Good morning from {brand}! {count} nodes active, {packets} packets/24h." />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save automations</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {err && <span className="text-[12px] text-accent-strong">{err}</span>}
      </div>
    </section>
  );
}
