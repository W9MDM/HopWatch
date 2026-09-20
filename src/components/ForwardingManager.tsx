"use client";

import { useState } from "react";
import { cn } from "../lib/cn.ts";

// Targets (Apprise URLs) are secrets and never sent to the browser; the list carries only a
// count. On edit, leaving targets blank retains the stored ones (keep_targets).
interface Rule { id: string; enabled: boolean; events: string[]; channels: string[]; target_count: number }
const EVENTS = [
  { key: "text", label: "Text messages" },
  { key: "new_node", label: "New nodes" },
];
const inputCls = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";

const EMPTY: Rule = { id: "", enabled: true, events: ["text"], channels: [], target_count: 0 };

// Mesh -> Discord/Apprise forwarding, meshmonitor-style: pick events + channels + targets.
export function ForwardingManager({ initial, channels }: { initial: Rule[]; channels: string[] }) {
  const [rules, setRules] = useState<Rule[]>(initial);
  const [form, setForm] = useState<Rule | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [targetsText, setTargetsText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const r = await fetch("/api/v1/admin/forwarding");
    if (r.ok) setRules((await r.json()).rules);
  }
  function startAdd() { setForm({ ...EMPTY }); setTargetsText(""); setEditing(null); setError(null); }
  // Editing never pre-fills the stored (secret) targets; blank means "keep what's stored".
  function startEdit(r: Rule) { setForm({ ...r }); setTargetsText(""); setEditing(r.id); setError(null); }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError(null);
    const targets = targetsText.split("\n").map((s) => s.trim()).filter(Boolean);
    const body = { ...form, targets, keep_targets: editing != null && targets.length === 0 };
    const res = await fetch("/api/v1/admin/forwarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) { setForm(null); await refresh(); }
    else setError((await res.json().catch(() => ({}))).error ?? "save failed");
  }
  async function remove(id: string) {
    if (!confirm(`Delete forwarding rule "${id}"?`)) return;
    const res = await fetch(`/api/v1/admin/forwarding?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) await refresh();
  }

  const set = (patch: Partial<Rule>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Forwarding (Discord / Apprise)</h2>
        <button className="btn btn-primary h-8 px-3 text-[13px]" onClick={startAdd}>Add rule</button>
      </div>
      {error && <p className="text-xs text-accent-strong">{error}</p>}

      <table className="data">
        <thead><tr><th>Rule</th><th>Events</th><th>Channels</th><th>Targets</th><th>On</th><th></th></tr></thead>
        <tbody>
          {rules.length === 0 && <tr><td colSpan={6} className="text-ink-faint">No forwarding rules.</td></tr>}
          {rules.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.id}</td>
              <td className="text-ink-mute">{r.events.join(", ")}</td>
              <td className="text-ink-faint">{r.channels.length ? r.channels.join(", ") : "all"}</td>
              <td className="text-ink-faint">{r.target_count}</td>
              <td>{r.enabled ? <span className="pill pill-on">on</span> : <span className="pill pill-off">off</span>}</td>
              <td className="text-right">
                <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => startEdit(r)}>Edit</button>{" "}
                <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => remove(r.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {form && (
        <form className="space-y-3 border-t border-line pt-4" onSubmit={save}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1"><span className="block stat-label">Rule id</span>
              <input className={inputCls + " w-40"} value={form.id} disabled={editing != null} onChange={(e) => set({ id: e.target.value })} placeholder="discord-main" />
            </label>
            <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> enabled</label>
            <span className="flex items-center gap-3">
              {EVENTS.map((ev) => (
                <label key={ev.key} className="flex items-center gap-1 text-[13px] text-ink-mute">
                  <input type="checkbox" checked={form.events.includes(ev.key)} onChange={() => set({ events: toggle(form.events, ev.key) })} /> {ev.label}
                </label>
              ))}
            </span>
          </div>

          <div>
            <span className="block stat-label mb-1">Channels (none = all)</span>
            <div className="flex flex-wrap gap-3">
              {channels.length === 0 && <span className="text-[12px] text-ink-faint">No channels seen yet; leave empty for all.</span>}
              {channels.map((c) => (
                <label key={c} className="flex items-center gap-1 text-[12px] text-ink-mute">
                  <input type="checkbox" checked={form.channels.includes(c)} onChange={() => set({ channels: toggle(form.channels, c) })} /> {c}
                </label>
              ))}
            </div>
          </div>

          <label className="block space-y-1"><span className="stat-label">Targets (Apprise URLs, one per line)</span>
            <textarea className="min-h-20 w-full rounded-md border border-line bg-raised px-3 py-2 font-mono text-[13px] text-ink focus:border-accent focus:outline-none" value={targetsText} onChange={(e) => setTargetsText(e.target.value)} placeholder={editing != null && form.target_count > 0 ? `${form.target_count} target(s) stored; leave blank to keep, or enter new ones to replace` : "discord://webhook_id/webhook_token\nhttps://discord.com/api/webhooks/…\nntfy://mytopic"} />
            <span className="text-[11px] text-ink-faint">Discord, ntfy, and generic webhooks work natively; install the <span className="mono">apprise</span> CLI for the full service list. Targets are encrypted at rest and never shown again after saving.</span>
          </label>

          <div className="flex gap-2">
            <button className={cn("btn btn-primary h-9 px-4 text-[13px]")} type="submit">Save rule</button>
            <button className="btn btn-outline h-9 px-4 text-[13px]" type="button" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
