"use client";

import { useState } from "react";

export interface ProfileInitial {
  username: string;
  role: string;
  discord_linked: string | null;
  discord_enabled: boolean;
  prefs: { default_broker?: string; default_channel?: string };
  brokers: string[];
  channels: string[];
}

const inp = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

export function ProfileManager({ initial }: { initial: ProfileInitial }) {
  const [linked, setLinked] = useState(initial.discord_linked);
  const [broker, setBroker] = useState(initial.prefs.default_broker ?? "");
  const [channel, setChannel] = useState(initial.prefs.default_channel ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setMsg(null); setError(null);
    const r = await fetch("/api/v1/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ default_broker: broker, default_channel: channel }) });
    if (r.ok) setMsg("Saved. Your defaults apply on your next visit to the maps.");
    else setError((await r.json().catch(() => ({}))).error ?? "save failed");
  }

  async function unlink() {
    if (!confirm("Unlink your Discord account? You can re-link it anytime.")) return;
    const r = await fetch("/api/v1/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "unlink_discord" }) });
    if (r.ok) setLinked(null);
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Account</h2>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]">
          <span className="text-ink-mute">Username <span className="text-ink">{initial.username}</span></span>
          <span className="text-ink-mute">Role <span className="text-ink">{initial.role}</span></span>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Discord login</h2>
        {linked ? (
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <span className="text-ink">Linked as <span className="text-ok">{linked}</span>. You can sign in with Discord.</span>
            <button className="btn btn-outline h-8 px-3 text-[12px]" onClick={unlink}>Unlink Discord</button>
          </div>
        ) : initial.discord_enabled ? (
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <span className="text-ink-faint">No Discord linked. Link it to sign in with Discord next time.</span>
            <a className="btn h-8 px-3 text-[12px]" style={{ background: "#5865F2", color: "#fff" }} href="/api/v1/auth/discord?mode=link">Link my Discord</a>
          </div>
        ) : (
          <p className="text-[13px] text-ink-faint">Discord login is not enabled on this server.</p>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Map defaults</h2>
        <p className="text-[12px] text-ink-faint">Which broker and channel the maps filter to by default. A filter in the page URL still overrides these.</p>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1"><span className="block stat-label">Default broker</span>
            <select value={broker} onChange={(e) => setBroker(e.target.value)} className={`${inp} w-56`}>
              <option value="">All brokers</option>
              {initial.brokers.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label className="space-y-1"><span className="block stat-label">Default channel</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className={`${inp} w-56`}>
              <option value="">All channels</option>
              {initial.channels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save defaults</button>
          {msg && <span className="text-[12px] text-ok">{msg}</span>}
          {error && <span className="text-[12px] text-accent-strong">{error}</span>}
        </div>
      </section>
    </div>
  );
}
