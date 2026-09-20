"use client";

import { useEffect, useState } from "react";

export interface AuthInitial {
  discord: { enabled: boolean; client_id: string; redirect_url: string; has_secret: boolean; auto_provision: boolean };
  session_ttl_hours: number;
  anonymous_read_only: boolean;
  linkedDiscord: string | null; // current admin's linked Discord name, if any
}

const inp = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

export function AuthManager({ initial }: { initial: AuthInitial }) {
  const [d, setD] = useState(initial.discord);
  const [secret, setSecret] = useState("");
  const [ttl, setTtl] = useState(initial.session_ttl_hours);
  const [anonRead, setAnonRead] = useState(initial.anonymous_read_only);
  const [linked, setLinked] = useState(initial.linkedDiscord);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { setOrigin(window.location.origin); }, []);

  // The redirect URI the app actually sends to Discord: the override if set, else this host's
  // callback. The admin pastes THIS into their Discord app's OAuth2 redirects.
  const redirectUri = d.redirect_url || (origin ? `${origin}/api/v1/auth/discord/callback` : "");

  async function save() {
    setMsg(null); setError(null);
    const r = await fetch("/api/v1/admin/auth", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ discord: { ...d, client_secret: secret }, session_ttl_hours: ttl, anonymous_read_only: anonRead }),
    });
    if (r.ok) { setMsg("Saved."); setSecret(""); if (secret) setD({ ...d, has_secret: true }); }
    else setError((await r.json().catch(() => ({}))).error ?? "save failed");
  }

  async function unlink() {
    const r = await fetch("/api/v1/admin/discord-unlink", { method: "POST" });
    if (r.ok) setLinked(null);
  }

  return (
    <section className="card space-y-4">
      <h2 className="eyebrow"><span className="eyebrow-bar" />Login &amp; Discord SSO</h2>

      <div className="space-y-2">
        <div className="stat-label">Your account</div>
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          {linked ? (
            <>
              <span className="text-ink">Discord linked: <span className="text-ok">{linked}</span></span>
              <button className="btn btn-outline h-8 px-3 text-[12px]" onClick={unlink}>Unlink Discord</button>
            </>
          ) : (
            <>
              <span className="text-ink-faint">No Discord linked to this account.</span>
              <a className="btn btn-outline h-8 px-3 text-[12px]" href="/api/v1/auth/discord?mode=link">Link my Discord</a>
            </>
          )}
        </div>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /> Enable Discord login
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1"><span className="block stat-label">Client ID</span><input value={d.client_id} onChange={(e) => setD({ ...d, client_id: e.target.value })} className={`${inp} w-56`} /></label>
          <label className="space-y-1"><span className="block stat-label">Client secret {d.has_secret && <span className="text-ink-faint">(set)</span>}</span><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={d.has_secret ? "leave blank to keep" : "paste secret"} className={`${inp} w-56`} /></label>
        </div>
        <div className="space-y-1">
          <span className="block stat-label">Redirect URI (add this to your Discord app: OAuth2 &rarr; Redirects)</span>
          <div className="flex items-center gap-2">
            <input readOnly value={redirectUri} className={`${inp} w-full max-w-2xl mono cursor-text`} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn btn-outline h-9 px-3 text-[12px]" onClick={async () => { try { await navigator.clipboard.writeText(redirectUri); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } }}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p className="text-[11px] text-ink-faint">The app sends this exact URL to Discord. Paste it into the Discord Developer Portal under your application&apos;s OAuth2 redirects, then enable Discord login below. Behind a Cloudflare Tunnel or reverse proxy where Node sees an internal host, set the override below and both this value and post-login redirects will use it.</p>
          {/^https?:\/\/(0\.0\.0\.0|127\.|localhost)/.test(redirectUri) && (
            <p className="text-[11px] text-accent-strong">This is an internal/local address (Discord rejects 0.0.0.0 and allows http only for localhost). Since your public URL is fixed, set the override below to your public https callback URL, e.g. https://your-host/api/v1/auth/discord/callback, and register the same in Discord.</p>
          )}
        </div>
        <details className="text-[12px]">
          <summary className="cursor-pointer stat-label">Override redirect URL (advanced)</summary>
          <input value={d.redirect_url} onChange={(e) => setD({ ...d, redirect_url: e.target.value })} placeholder={origin ? `${origin}/api/v1/auth/discord/callback` : "https://your-host/api/v1/auth/discord/callback"} className={`${inp} mt-1 w-full max-w-2xl`} />
          <p className="mt-1 text-[11px] text-ink-faint">Leave blank to use this host automatically. Set only if HopWatch is reached at a different public URL (e.g. behind a reverse proxy) than the browser origin.</p>
        </details>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={d.auto_provision} onChange={(e) => setD({ ...d, auto_provision: e.target.checked })} /> Auto-create accounts on first Discord login
        </label>
        <p className="text-[11px] text-ink-faint">On: any Discord user can sign in and gets a Member account (anonymous-level access plus owned nodes; set the Member role under Roles). Off: only accounts already linked to a Discord id can sign in.</p>
      </div>

      <div className="border-t border-line pt-3">
        <label className="space-y-1"><span className="block stat-label">Session lifetime (hours)</span><input type="number" value={String(ttl)} onChange={(e) => setTtl(Number(e.target.value))} className={`${inp} w-28`} /></label>
        <p className="mt-1 text-[11px] text-ink-faint">Default 720 (30 days). Applies to new logins.</p>
      </div>

      <div className="border-t border-line pt-3">
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={anonRead} onChange={(e) => setAnonRead(e.target.checked)} /> Allow anonymous read access
        </label>
        <p className="mt-1 text-[11px] text-ink-faint">On (default): visitors without an account get the public role&apos;s modules. Off: all reads require a signed-in session or an API token; anonymous requests are denied.</p>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save login settings</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {error && <span className="text-[12px] text-accent-strong">{error}</span>}
      </div>
    </section>
  );
}
