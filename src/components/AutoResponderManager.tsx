"use client";

import { useState } from "react";

export interface WelcomeSettings {
  enabled: boolean; within_hops: number; reply_via: "dm" | "channel"; channel: string; message: string;
}
export interface SpamNudgeSettings {
  enabled: boolean; threshold: number; window_minutes: number; cooldown_minutes: number; message: string;
}
export interface AutoResponderSettings {
  enabled: boolean; cooldown_s: number; respond_to_dm: boolean; respond_to_channel: boolean;
  reply_channel: string;
  reply_transport?: "match" | "both" | "fixed";
  triggers: { pattern: string; reply: string; reply_mqtt?: string; reply_via?: "match" | "dm" | "channel"; channels?: string[] }[];
  welcome?: WelcomeSettings;
  spam_nudge?: SpamNudgeSettings;
}

const WELCOME_DEFAULT: WelcomeSettings = { enabled: false, within_hops: 0, reply_via: "channel", channel: "", message: "Welcome to the mesh, {name}! Heard you {hops} hop(s) away via {via}." };
const SPAM_NUDGE_DEFAULT: SpamNudgeSettings = { enabled: false, threshold: 6, window_minutes: 10, cooldown_minutes: 60, message: "Hi {short}, we are seeing {count} repeats of the same message from you on the mesh. If you are testing, a couple is plenty. Thanks for keeping the airwaves clear! 73" };

const inputCls = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

// MeshMonitor-style auto-responder editor (its own settings tab). Replies to inbound text matching
// a trigger, echoing observed link quality. Patches only tx.auto_responder via its own endpoint.
export function AutoResponderManager({ initial }: { initial: AutoResponderSettings }) {
  const [ar, setAr] = useState<AutoResponderSettings>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<AutoResponderSettings>) => setAr({ ...ar, ...patch });
  const setTrig = (i: number, patch: Partial<{ pattern: string; reply: string; reply_mqtt: string; reply_via: "match" | "dm" | "channel"; channels: string[] }>) =>
    set({ triggers: ar.triggers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const w = ar.welcome ?? WELCOME_DEFAULT;
  const setW = (patch: Partial<WelcomeSettings>) => set({ welcome: { ...w, ...patch } });
  const sn = ar.spam_nudge ?? SPAM_NUDGE_DEFAULT;
  const setSN = (patch: Partial<SpamNudgeSettings>) => set({ spam_nudge: { ...sn, ...patch } });

  async function save() {
    setMsg(null); setErr(null);
    const r = await fetch("/api/v1/admin/tx/auto-responder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...ar, welcome: w, spam_nudge: sn }) });
    if (r.ok) setMsg("Saved. Auto-responder config hot-reloads on the worker within ~10s.");
    else setErr((await r.json().catch(() => ({}))).error ?? "save failed");
  }

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="eyebrow"><span className="eyebrow-bar" />Auto-responder</h2>
        <p className="mt-1 text-[13px] text-ink-faint">Replies to inbound text matching a trigger, echoing link quality. Requires TX enabled + armed + dry-run off to actually send.</p>
      </div>

      <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={ar.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={ar.respond_to_dm} onChange={(e) => set({ respond_to_dm: e.target.checked })} /> react to DMs</label>
        <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={ar.respond_to_channel} onChange={(e) => set({ respond_to_channel: e.target.checked })} /> react to channel messages</label>
        <label className="flex items-center gap-2 text-[13px] text-ink-mute">cooldown <input type="number" value={String(ar.cooldown_s)} onChange={(e) => set({ cooldown_s: Number(e.target.value) })} className={`${inputCls} w-24`} /> s</label>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1"><span className="block stat-label">Reply channel (for channel replies)</span>
          <input value={ar.reply_channel ?? ""} onChange={(e) => set({ reply_channel: e.target.value })} placeholder="LongFast" className={`${inputCls} w-48`} />
        </label>
        <label className="space-y-1"><span className="block stat-label">Reply transport</span>
          <select value={ar.reply_transport ?? "match"} onChange={(e) => set({ reply_transport: e.target.value as "match" | "both" | "fixed" })} className={`${inputCls} w-56`}>
            <option value="match">match how it was heard (RF or MQTT)</option>
            <option value="both">both RF and MQTT</option>
            <option value="fixed">always the TX transport</option>
          </select>
        </label>
      </div>
      <span className="block text-[11px] text-ink-faint">Reply channel: the channel a non-DM reply broadcasts on (blank = the channel the message arrived on). Set it to a channel your node can transmit on (e.g. LongFast) if it decodes channels it is not a member of. Reply transport: <b>match</b> answers a node on the link it was heard on, so a station reachable only over MQTT (several hops away, not an RF neighbour) still gets a reply; <b>both</b> sends on RF and MQTT (may double for the sender); <b>fixed</b> always uses the TX transport.</span>

      <div className="space-y-1.5">
        <span className="stat-label">Triggers (first match wins). Reply vars: {"{name} {short} {id} {rssi} {snr} {hops} {via} {msg} {count} {time}"}</span>
        <p className="text-[11px] text-ink-faint">Pattern is a case-insensitive regex matched <strong>anywhere</strong> in the message: <span className="mono">{"\\btest\\b"}</span> fires on &quot;this is a test&quot;, <span className="mono">test</span> also matches &quot;latest&quot;, and <span className="mono">^test$</span> only the exact word. <span className="mono">{"{via}"}</span> renders RF or MQTT. <strong>Reply</strong> chooses how the reply is sent: Match (same as the incoming), DM (private to sender), or Channel (broadcast on that channel).</p>
        {ar.triggers.map((t, i) => (
          <div key={i} className="space-y-1 rounded-md border border-line p-2">
            <div className="flex flex-wrap items-center gap-2">
              <input value={t.pattern} onChange={(e) => setTrig(i, { pattern: e.target.value })} placeholder="\btest\b" className={`${inputCls} w-32`} />
              <span className="text-ink-faint">&rarr;</span>
              <input value={t.reply} onChange={(e) => setTrig(i, { reply: e.target.value })} placeholder="RF reply: pong to {short}: {rssi} dBm, {hops} hop(s)" title="Reply used when heard over RF" className={`${inputCls} min-w-64 flex-1`} />
              <select value={t.reply_via ?? "match"} onChange={(e) => setTrig(i, { reply_via: e.target.value as "match" | "dm" | "channel" })} className={`${inputCls} w-28`} title="How to send this reply">
                <option value="match">via: match</option>
                <option value="dm">via: DM</option>
                <option value="channel">via: channel</option>
              </select>
              <button type="button" className="btn btn-outline h-8 px-2 text-[12px]" onClick={() => set({ triggers: ar.triggers.filter((_, j) => j !== i) })}>remove</button>
            </div>
            <input value={t.reply_mqtt ?? ""} onChange={(e) => setTrig(i, { reply_mqtt: e.target.value })} placeholder="MQTT reply (optional; blank = use the RF reply). Omit {rssi}/{snr} -- MQTT has none." title="Reply used when heard over MQTT" className={`${inputCls} w-full`} />
            <input value={(t.channels ?? []).join(", ")} onChange={(e) => setTrig(i, { channels: e.target.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) })} placeholder="Only on channels (comma-separated names; blank = any), e.g. Testing" title="Restrict this trigger to specific channels by name" className={`${inputCls} w-full`} />
          </div>
        ))}
        <button type="button" className="btn btn-outline h-8 px-3 text-[12px]" onClick={() => set({ triggers: [...ar.triggers, { pattern: "", reply: "", reply_mqtt: "", reply_via: "match", channels: [] }] })}>add trigger</button>
      </div>

      <div className="space-y-2 rounded-md border border-line p-3">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={w.enabled} onChange={(e) => setW({ enabled: e.target.checked })} /> Welcome new nodes</label>
        <p className="text-[11px] text-ink-faint">Greets each node the first time it is heard (once per node), if it is within the hop limit below. Only nodes first seen in the last hour are greeted, so enabling this will not flood-welcome existing nodes. Requires TX enabled + armed + dry-run off.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1"><span className="block stat-label">Within hops (0 = direct only)</span>
            <input type="number" min={0} max={7} value={String(w.within_hops)} onChange={(e) => setW({ within_hops: Number(e.target.value) })} className={`${inputCls} w-40`} />
          </label>
          <label className="space-y-1"><span className="block stat-label">Send as</span>
            <select value={w.reply_via} onChange={(e) => setW({ reply_via: e.target.value as "dm" | "channel" })} className={`${inputCls} w-40`}>
              <option value="channel">Channel broadcast</option>
              <option value="dm">DM to the node</option>
            </select>
          </label>
          {w.reply_via === "channel" && (
            <label className="space-y-1"><span className="block stat-label">Channel (blank = primary)</span>
              <input value={w.channel} onChange={(e) => setW({ channel: e.target.value })} placeholder="LongFast" className={`${inputCls} w-40`} />
            </label>
          )}
        </div>
        <input value={w.message} onChange={(e) => setW({ message: e.target.value })} placeholder="Welcome to the mesh, {name}! {hops} hop(s) away." className={`${inputCls} w-full`} />
      </div>

      <div className="space-y-2 rounded-md border border-line p-3">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={sn.enabled} onChange={(e) => setSN({ enabled: e.target.checked })} /> Politely nudge repeat spammers</label>
        <p className="text-[11px] text-ink-faint">DMs a node once when it repeats the same message at least the threshold below within the window, then stays quiet for the cooldown so the nudge never becomes spam itself. Requires TX enabled + armed + dry-run off. Vars: {"{short} {name} {count} {msg}"}.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1"><span className="block stat-label">Repeats to trigger</span>
            <input type="number" min={2} value={String(sn.threshold)} onChange={(e) => setSN({ threshold: Number(e.target.value) })} className={`${inputCls} w-28`} />
          </label>
          <label className="space-y-1"><span className="block stat-label">Within (minutes)</span>
            <input type="number" min={1} value={String(sn.window_minutes)} onChange={(e) => setSN({ window_minutes: Number(e.target.value) })} className={`${inputCls} w-28`} />
          </label>
          <label className="space-y-1"><span className="block stat-label">Cooldown per node (minutes)</span>
            <input type="number" min={1} value={String(sn.cooldown_minutes)} onChange={(e) => setSN({ cooldown_minutes: Number(e.target.value) })} className={`${inputCls} w-40`} />
          </label>
        </div>
        <input value={sn.message} onChange={(e) => setSN({ message: e.target.value })} placeholder="Hi {short}, that is {count} repeats..." className={`${inputCls} w-full`} />
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save auto-responder</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {err && <span className="text-[12px] text-accent-strong">{err}</span>}
      </div>
    </section>
  );
}
