"use client";

import { useState } from "react";

type Channel = "webhook" | "ntfy" | "discord" | "smtp";
interface Rule {
  id: string;
  type: string;
  enabled: boolean;
  channels: Channel[];
  [k: string]: unknown;
}
interface Init {
  smtp: { host: string; port: number; user: string; from: string; starttls: boolean; has_password: boolean };
  // Counts, not values: a webhook URL embeds its own bearer token, so it is never sent to the
  // browser (Rule 6). Blank boxes keep what is stored; typing replaces; the clear box empties.
  webhook_count: number;
  ntfy_count: number;
  discord: { username: string; avatar_url: string; webhook_count: number };
  rules: Rule[];
  digest: { enabled: boolean; time: string; channels: Channel[]; attach_ics: boolean };
}

const CHANNELS: Channel[] = ["webhook", "ntfy", "discord", "smtp"];
const inputCls = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";

function thresholdField(type: string): { key: string; label: string; step: string } | null {
  switch (type) {
    case "node_offline": return { key: "threshold_minutes", label: "minutes", step: "1" };
    case "gateway_silent": return { key: "threshold_minutes", label: "minutes", step: "1" };
    case "battery_threshold": return { key: "threshold_volts", label: "volts", step: "0.1" };
    case "channel_util": return { key: "threshold_pct", label: "percent", step: "1" };
    case "battery_forecast": return { key: "days_ahead", label: "days", step: "1" };
    default: return null;
  }
}

export function NotificationsManager({ initial }: { initial: Init }) {
  const [smtp, setSmtp] = useState(initial.smtp);
  const [smtpPw, setSmtpPw] = useState("");
  const [webhook, setWebhook] = useState("");
  const [ntfy, setNtfy] = useState("");
  const [clearWebhook, setClearWebhook] = useState(false);
  const [clearNtfy, setClearNtfy] = useState(false);
  const [discordUser, setDiscordUser] = useState(initial.discord.username);
  const [discordAvatar, setDiscordAvatar] = useState(initial.discord.avatar_url);
  const [discordHooks, setDiscordHooks] = useState("");
  const [clearDiscord, setClearDiscord] = useState(false);
  const [rules, setRules] = useState<Rule[]>(initial.rules);
  const [digest, setDigest] = useState(initial.digest);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleChannel(list: Channel[], ch: Channel): Channel[] {
    return list.includes(ch) ? list.filter((c) => c !== ch) : [...list, ch];
  }

  async function save(testDiscord = false) {
    setMsg(null);
    setError(null);
    setBusy(true);
    const body = {
      smtp: { ...smtp, password: smtpPw },
      webhook: webhook.split("\n").map((s) => s.trim()).filter(Boolean),
      ntfy: ntfy.split("\n").map((s) => s.trim()).filter(Boolean),
      clear_webhook: clearWebhook,
      clear_ntfy: clearNtfy,
      discord: { username: discordUser, avatar_url: discordAvatar },
      discord_webhooks: discordHooks.split("\n").map((s) => s.trim()).filter(Boolean),
      clear_discord: clearDiscord,
      test_discord: testDiscord,
      rules,
      digest,
    };
    const res = await fetch("/api/v1/admin/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.ok) {
      const d = await res.json().catch(() => ({}));
      const testNote = d.test === "sent" ? " Test posted to Discord." : d.test ? ` Test: ${d.test}.` : "";
      setMsg(`Saved. The worker picks up changes within about a minute.${testNote}`);
      setSmtpPw("");
      if (smtpPw) setSmtp({ ...smtp, has_password: true });
    } else {
      setError((await res.json().catch(() => ({}))).error ?? "save failed");
    }
  }

  return (
    <div className="card space-y-5">
      <h2 className="eyebrow"><span className="eyebrow-bar" />Notifications &amp; alerts</h2>
      {error && <p className="text-xs text-accent-strong">{error}</p>}
      {msg && <p className="text-xs text-ok">{msg}</p>}

      {/* SMTP */}
      <div>
        <div className="stat-label mb-2">SMTP</div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <input className={inputCls} placeholder="host" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} />
          <input className={inputCls} type="number" placeholder="port" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) })} />
          <input className={inputCls} placeholder="from address" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} />
          <input className={inputCls} placeholder="username" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} />
          <input className={inputCls} type="password" placeholder={smtp.has_password ? "(unchanged)" : "password"} value={smtpPw} onChange={(e) => setSmtpPw(e.target.value)} autoComplete="new-password" />
          <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={smtp.starttls} onChange={(e) => setSmtp({ ...smtp, starttls: e.target.checked })} /> STARTTLS</label>
        </div>
        <p className="mt-1 text-[11px] text-ink-faint">Password is encrypted at rest (AES-256-GCM); the key stays in env.</p>
      </div>

      {/* Delivery targets */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1"><span className="stat-label">Webhook URLs (one per line)</span>
          <textarea className="min-h-16 w-full rounded-md border border-line bg-raised px-3 py-2 text-[13px] font-mono text-ink focus:border-accent focus:outline-none"
            placeholder={initial.webhook_count > 0 ? `${initial.webhook_count} stored (hidden); enter URLs to replace them` : "https://..."}
            value={webhook} onChange={(e) => setWebhook(e.target.value)} />
          {initial.webhook_count > 0 && (
            <span className="flex items-center gap-2 text-[11px] text-ink-faint">
              <input type="checkbox" checked={clearWebhook} onChange={(e) => setClearWebhook(e.target.checked)} /> remove all stored webhook targets
            </span>
          )}
        </label>
        <label className="space-y-1"><span className="stat-label">ntfy topics or URLs (one per line)</span>
          <textarea className="min-h-16 w-full rounded-md border border-line bg-raised px-3 py-2 text-[13px] font-mono text-ink focus:border-accent focus:outline-none"
            placeholder={initial.ntfy_count > 0 ? `${initial.ntfy_count} stored (hidden); enter topics to replace them` : "mytopic"}
            value={ntfy} onChange={(e) => setNtfy(e.target.value)} />
          {initial.ntfy_count > 0 && (
            <span className="flex items-center gap-2 text-[11px] text-ink-faint">
              <input type="checkbox" checked={clearNtfy} onChange={(e) => setClearNtfy(e.target.checked)} /> remove all stored ntfy targets
            </span>
          )}
        </label>
      </div>

      {/* Discord (branded "send as") */}
      <div>
        <div className="stat-label mb-2">Discord</div>
        <p className="mb-2 text-[11px] text-ink-faint">
          Posts alerts and the daily digest to a Discord channel as a branded identity. In Discord: Channel &rarr;
          Edit &rarr; Integrations &rarr; Webhooks &rarr; New Webhook, then paste the webhook URL below. The name and
          avatar here are the &quot;send as&quot; override, so posts appear from that identity (e.g. HopWatch) rather than a
          person or a generic bot. Add &quot;discord&quot; to a rule or the digest to route to it. Webhook URLs are
          encrypted at rest (Rule 6).
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <input className={inputCls} placeholder="Send-as name (e.g. HopWatch)" value={discordUser} onChange={(e) => setDiscordUser(e.target.value)} />
          <input className={inputCls} placeholder="Avatar image URL (optional)" value={discordAvatar} onChange={(e) => setDiscordAvatar(e.target.value)} />
        </div>
        <label className="mt-3 block space-y-1"><span className="stat-label">Discord webhook URLs (one per line)</span>
          <textarea className="min-h-16 w-full rounded-md border border-line bg-raised px-3 py-2 text-[13px] font-mono text-ink focus:border-accent focus:outline-none"
            placeholder={initial.discord.webhook_count > 0 ? `${initial.discord.webhook_count} stored (hidden); enter URLs to replace them` : "https://discord.com/api/webhooks/..."}
            value={discordHooks} onChange={(e) => setDiscordHooks(e.target.value)} />
        </label>
        <div className="mt-1 flex flex-wrap items-center gap-4">
          {initial.discord.webhook_count > 0 && (
            <span className="flex items-center gap-2 text-[11px] text-ink-faint">
              <input type="checkbox" checked={clearDiscord} onChange={(e) => setClearDiscord(e.target.checked)} /> remove all stored Discord webhooks
            </span>
          )}
          <button type="button" className="btn btn-outline h-8 px-3 text-[12px]" disabled={busy} onClick={() => save(true)}>Save &amp; send test post</button>
        </div>
      </div>

      {/* Alert rules */}
      <div>
        <div className="stat-label mb-2">Alert rules</div>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr><th>Rule</th><th>On</th><th>Threshold</th><th>Channels</th></tr>
            </thead>
            <tbody>
              {rules.length === 0 && <tr><td colSpan={4} className="text-ink-faint">No rules configured.</td></tr>}
              {rules.map((r, i) => {
                const tf = thresholdField(r.type);
                return (
                  <tr key={r.id}>
                    <td><span className="text-ink">{r.id}</span> <span className="text-[11px] text-ink-faint">{r.type}</span></td>
                    <td><input type="checkbox" checked={r.enabled} onChange={(e) => setRules(rules.map((x, j) => j === i ? { ...x, enabled: e.target.checked } : x))} /></td>
                    <td>
                      {tf ? (
                        <span className="flex items-center gap-1">
                          <input className={inputCls + " w-20"} type="number" step={tf.step} value={String(r[tf.key] ?? "")} onChange={(e) => setRules(rules.map((x, j) => j === i ? { ...x, [tf.key]: Number(e.target.value) } : x))} />
                          <span className="text-[11px] text-ink-faint">{tf.label}</span>
                        </span>
                      ) : <span className="text-ink-faint">-</span>}
                    </td>
                    <td>
                      <div className="flex gap-3">
                        {CHANNELS.map((ch) => (
                          <label key={ch} className="flex items-center gap-1 text-[12px] text-ink-mute">
                            <input type="checkbox" checked={r.channels.includes(ch)} onChange={() => setRules(rules.map((x, j) => j === i ? { ...x, channels: toggleChannel(x.channels, ch) } : x))} />
                            {ch}
                          </label>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Digest */}
      <div>
        <div className="stat-label mb-2">Daily digest</div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={digest.enabled} onChange={(e) => setDigest({ ...digest, enabled: e.target.checked })} /> enabled</label>
          <label className="flex items-center gap-2 text-[13px] text-ink-mute">time <input className={inputCls + " w-24"} value={digest.time} onChange={(e) => setDigest({ ...digest, time: e.target.value })} placeholder="08:00" /></label>
          <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={digest.attach_ics} onChange={(e) => setDigest({ ...digest, attach_ics: e.target.checked })} /> attach .ics</label>
          <span className="flex items-center gap-3">
            {CHANNELS.map((ch) => (
              <label key={ch} className="flex items-center gap-1 text-[12px] text-ink-mute">
                <input type="checkbox" checked={digest.channels.includes(ch)} onChange={() => setDigest({ ...digest, channels: toggleChannel(digest.channels, ch) })} />
                {ch}
              </label>
            ))}
          </span>
        </div>
      </div>

      <button className="btn btn-primary h-9 px-4 text-[13px]" disabled={busy} onClick={() => save(false)}>Save notifications</button>
    </div>
  );
}
