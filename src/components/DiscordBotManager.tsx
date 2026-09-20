"use client";

import { useEffect, useState } from "react";

interface Init { enabled: boolean; application_id: string; public_key: string; guild_id: string; has_token: boolean }

const inp = "h-9 w-full rounded-md border border-line bg-raised px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";

// Admin panel for the Discord slash-command bot (HTTP interactions). Application id + public key +
// optional guild id round-trip; the bot token is write-only (blank keeps the stored, encrypted one).
export function DiscordBotManager({ initial }: { initial: Init }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [appId, setAppId] = useState(initial.application_id);
  const [pubKey, setPubKey] = useState(initial.public_key);
  const [guildId, setGuildId] = useState(initial.guild_id);
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(initial.has_token);
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { try { setEndpoint(`${window.location.origin}/api/v1/discord/interactions`); } catch { /* SSR */ } }, []);

  const pubKeyOk = /^[0-9a-fA-F]{64}$/.test(pubKey.trim());

  async function save() {
    setBusy(true); setMsg(null); setErr(null);
    const res = await fetch("/api/v1/admin/discord-bot", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled, application_id: appId, public_key: pubKey, guild_id: guildId, bot_token: token }),
    });
    setBusy(false);
    if (res.ok) { setMsg("Saved. Changes apply within about 5 seconds."); if (token) setHasToken(true); setToken(""); }
    else setErr((await res.json().catch(() => ({}))).error ?? "save failed");
  }

  async function register() {
    setBusy(true); setMsg(null); setErr(null);
    const res = await fetch("/api/v1/admin/discord-bot", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "register" }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) setMsg(`Registered ${d.registered} command(s) (${d.scope}). ${d.scope === "global" ? "Global commands can take up to an hour to appear." : "Guild commands are available immediately."}`);
    else setErr(d.error ?? "register failed");
  }

  return (
    <div className="card space-y-4">
      <h2 className="eyebrow"><span className="eyebrow-bar" />Discord bot (slash commands)</h2>
      <p className="text-[12px] text-ink-faint">
        Serves slash commands (/reach, /node, /myreach, /status, /claim) over HTTP interactions, no persistent
        connection. Create an application at the Discord Developer Portal, paste its values here, then set the
        <span className="text-ink"> Interactions Endpoint URL</span> below in the portal (Discord verifies it on save,
        so save these settings and enable the bot first). The bot token is encrypted at rest (Rule 6).
      </p>
      {err && <p className="text-xs text-accent-strong">{err}</p>}
      {msg && <p className="text-xs text-ok">{msg}</p>}

      <label className="flex items-center gap-2 text-[13px] text-ink-mute">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Bot enabled (endpoint answers Discord)
      </label>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1"><span className="stat-label">Application ID</span>
          <input className={inp} value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="e.g. 123456789012345678" />
        </label>
        <label className="space-y-1"><span className="stat-label">Guild ID (optional, for instant commands)</span>
          <input className={inp} value={guildId} onChange={(e) => setGuildId(e.target.value)} placeholder="your server id, or leave blank for global" />
        </label>
        <label className="space-y-1 md:col-span-2"><span className="stat-label">Public key (64 hex characters)</span>
          <input className={inp} value={pubKey} onChange={(e) => setPubKey(e.target.value)} placeholder="from Developer Portal -> General Information" />
          {pubKey.trim() !== "" && !pubKeyOk && <span className="text-[11px] text-accent-strong">Expected 64 hex characters; this looks incomplete ({pubKey.trim().length}).</span>}
        </label>
        <label className="space-y-1 md:col-span-2"><span className="stat-label">Bot token</span>
          <input className={inp} type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={hasToken ? "(stored, unchanged)" : "from Developer Portal -> Bot -> Reset Token"} />
        </label>
      </div>

      <label className="space-y-1 block"><span className="stat-label">Interactions Endpoint URL (paste this into the portal)</span>
        <input className={inp + " font-mono"} readOnly value={endpoint} onFocus={(e) => e.currentTarget.select()} />
      </label>

      <div className="flex flex-wrap gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" disabled={busy} onClick={save}>Save bot settings</button>
        <button className="btn btn-outline h-9 px-4 text-[13px]" disabled={busy} onClick={register} title="Push the slash-command definitions to Discord">Register slash commands</button>
      </div>
    </div>
  );
}
