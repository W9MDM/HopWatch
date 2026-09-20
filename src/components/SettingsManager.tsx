"use client";

import { useEffect, useState } from "react";
import { cn } from "../lib/cn.ts";

interface Broker {
  id: string;
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  client_id: string;
  tls_enabled: boolean;
  tls_insecure: boolean;
  qos: number;
  topics: string[];
  root_topic: string;
  log_file: string;
}
interface ChannelKey {
  name: string;
  has_key: boolean;
}

const EMPTY: Broker = {
  id: "", enabled: true, host: "", port: 1883, username: "", has_password: false,
  client_id: "", tls_enabled: false, tls_insecure: false, qos: 0, topics: ["msh/#"], root_topic: "", log_file: "",
};

const inputCls = "h-9 w-full rounded-md border border-line bg-raised px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";

export function SettingsManager({ initialBrokers, initialKeys }: { initialBrokers: Broker[]; initialKeys: ChannelKey[] }) {
  const [brokers, setBrokers] = useState<Broker[]>(initialBrokers);
  const [keys, setKeys] = useState<ChannelKey[]>(initialKeys);
  const [form, setForm] = useState<Broker | null>(null);
  const [pw, setPw] = useState("");
  const [topicsText, setTopicsText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [keyVal, setKeyVal] = useState("");

  interface Status { broker_id: string; connected: number; last_message_at: string | null; messages: number; malformed: number }
  const [status, setStatus] = useState<Status[]>([]);
  const [reloading, setReloading] = useState(false);

  async function fetchStatus() {
    const r = await fetch("/api/v1/admin/ingest-status");
    if (r.ok) setStatus((await r.json()).brokers);
  }
  async function reloadIngest() {
    setReloading(true);
    await fetch("/api/v1/admin/ingest-status", { method: "POST" }).catch(() => {});
    // Poll status while the ingest daemon picks up the change (~5s poll).
    let n = 0;
    const t = setInterval(async () => {
      await fetchStatus();
      if (++n >= 8) {
        clearInterval(t);
        setReloading(false);
      }
    }, 2000);
  }
  useEffect(() => {
    void fetchStatus();
    const t = setInterval(fetchStatus, 5000);
    return () => clearInterval(t);
  }, []);

  function ageStr(ts: string | null): string {
    if (!ts) return "never";
    const d = new Date((ts.includes("T") ? ts : ts.replace(" ", "T")) + "Z");
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  }

  async function refreshBrokers() {
    const r = await fetch("/api/v1/admin/brokers");
    if (r.ok) setBrokers((await r.json()).brokers);
  }
  async function refreshKeys() {
    const r = await fetch("/api/v1/admin/channel-keys");
    if (r.ok) setKeys((await r.json()).channel_keys);
  }

  function startAdd() {
    setForm({ ...EMPTY });
    setTopicsText(EMPTY.topics.join("\n"));
    setPw("");
    setEditingId(null);
    setError(null);
  }
  function startEdit(b: Broker) {
    setForm({ ...b });
    setTopicsText(b.topics.join("\n"));
    setPw("");
    setEditingId(b.id);
    setError(null);
  }

  async function saveBroker(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError(null);
    const topics = topicsText.split("\n").map((t) => t.trim()).filter(Boolean);
    const body = {
      ...form,
      port: Number(form.port),
      qos: Number(form.qos),
      topics,
      password: pw,
      keep_password: editingId != null && pw === "",
    };
    const res = await fetch("/api/v1/admin/brokers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setForm(null);
      await refreshBrokers();
    } else {
      setError((await res.json().catch(() => ({}))).error ?? "save failed");
    }
  }

  async function deleteBroker(id: string) {
    if (!confirm(`Delete broker "${id}"?`)) return;
    const res = await fetch(`/api/v1/admin/brokers?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) await refreshBrokers();
  }

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/v1/admin/channel-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: keyName, key: keyVal }),
    });
    if (res.ok) {
      setKeyName("");
      setKeyVal("");
      await refreshKeys();
    } else {
      setError((await res.json().catch(() => ({}))).error ?? "save failed");
    }
  }
  async function deleteKey(name: string) {
    const res = await fetch(`/api/v1/admin/channel-keys?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    if (res.ok) await refreshKeys();
  }

  const set = (patch: Partial<Broker>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="space-y-6">
      {error && <p className="text-xs text-accent-strong">{error}</p>}

      {/* Brokers */}
      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="eyebrow"><span className="eyebrow-bar" />MQTT brokers</h2>
          <div className="flex items-center gap-2">
            <button className="btn btn-outline h-8 px-3 text-[13px]" onClick={reloadIngest} disabled={reloading}>
              {reloading ? "Reloading…" : "Reload ingest"}
            </button>
            <button className="btn btn-primary h-8 px-3 text-[13px]" onClick={startAdd}>Add broker</button>
          </div>
        </div>
        <table className="data">
          <thead>
            <tr><th>ID</th><th>Endpoint</th><th>TLS</th><th>Topics</th><th>State</th><th></th></tr>
          </thead>
          <tbody>
            {brokers.length === 0 && <tr><td colSpan={6} className="text-ink-faint">No brokers configured.</td></tr>}
            {brokers.map((b) => (
              <tr key={b.id}>
                <td className="mono">{b.id}</td>
                <td className="mono text-ink-mute">{b.host}:{b.port}</td>
                <td className="text-ink-faint">{b.tls_enabled ? "tls" : "plain"}</td>
                <td className="text-ink-faint">{b.topics.length}</td>
                <td>{b.enabled ? <span className="pill pill-on">enabled</span> : <span className="pill pill-off">disabled</span>}</td>
                <td className="text-right">
                  <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => startEdit(b)}>Edit</button>{" "}
                  <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => deleteBroker(b.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {status.length > 0 && (
          <div className="mt-3 border-t border-line pt-3">
            <div className="stat-label mb-2">Ingest connection status</div>
            <div className="flex flex-wrap gap-3">
              {status.map((b) => (
                <div key={b.broker_id} className="flex items-center gap-2 rounded-md border border-line bg-raised px-3 py-1.5 text-[12px]">
                  <span className={cn("inline-block h-2 w-2 rounded-full", b.connected ? "bg-ok" : "bg-ink-faint")} />
                  <span className="mono text-ink">{b.broker_id}</span>
                  <span className="text-ink-faint">{b.connected ? "connected" : "down"}</span>
                  <span className="text-ink-faint">· {ageStr(b.last_message_at)} ago</span>
                  <span className="text-ink-faint">· {b.messages} msgs</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {form && (
          <form className="mt-4 grid grid-cols-1 gap-3 border-t border-line pt-4 md:grid-cols-2" onSubmit={saveBroker}>
            <label className="space-y-1"><span className="stat-label">ID</span>
              <input className={inputCls} value={form.id} disabled={editingId != null} onChange={(e) => set({ id: e.target.value })} placeholder="primary" />
            </label>
            <label className="space-y-1"><span className="stat-label">Host</span>
              <input className={inputCls} value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="192.168.1.50 or mqtt.example.org" />
            </label>
            <label className="space-y-1"><span className="stat-label">Port</span>
              <input className={inputCls} type="number" value={form.port} onChange={(e) => set({ port: Number(e.target.value) })} />
            </label>
            <label className="space-y-1"><span className="stat-label">Client ID</span>
              <input className={inputCls} value={form.client_id} onChange={(e) => set({ client_id: e.target.value })} placeholder="hopwatch-primary" />
            </label>
            <label className="space-y-1"><span className="stat-label">Username</span>
              <input className={inputCls} value={form.username} onChange={(e) => set({ username: e.target.value })} placeholder="(optional)" />
            </label>
            <label className="space-y-1"><span className="stat-label">Password</span>
              <input className={inputCls} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={form.has_password && editingId ? "(unchanged)" : "(optional)"} />
            </label>
            <label className="space-y-1 md:col-span-2"><span className="stat-label">Topics / region roots (one per line)</span>
              <textarea className="min-h-20 w-full rounded-md border border-line bg-raised px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none font-mono" value={topicsText} onChange={(e) => setTopicsText(e.target.value)} placeholder={"msh/US/IN/NWI\nmsh/US/IL/Chicago"} />
              <p className="text-[11px] text-ink-faint">
                Enter your Meshtastic region root(s), e.g. <span className="mono">msh/US/IN/NWI</span>. We auto-watch everything under it
                (<span className="mono">/#</span> is added for you). <span className="mono">msh/#</span> catches all regions on the broker.
                Full MQTT wildcards (<span className="mono">+</span>, <span className="mono">#</span>) are accepted as-is.
              </p>
            </label>
            <label className="space-y-1 md:col-span-2"><span className="stat-label">Root topic (MQTT bridge)</span>
              <input className={inputCls} value={form.root_topic} onChange={(e) => set({ root_topic: e.target.value })} placeholder="msh/US/IN/NWI" />
              <p className="text-[11px] text-ink-faint">
                This broker's topic namespace, e.g. <span className="mono">msh/US/IN/NWI</span>. The MQTT bridge republishes
                forwarded messages under this root (the <span className="mono">/2/e/&lt;channel&gt;/&lt;gateway&gt;</span> suffix is preserved).
                Leave blank to derive it from the first subscribe topic above.
              </p>
            </label>
            <label className="space-y-1 md:col-span-2"><span className="stat-label">Mosquitto log file (connected-client list)</span>
              <input className={inputCls} value={form.log_file} onChange={(e) => set({ log_file: e.target.value })} placeholder="/var/log/mosquitto/mosquitto.log" />
              <p className="text-[11px] text-ink-faint">
                Only for a broker running on the HopWatch host. When set and readable, ingest parses this log to list the
                clients currently connected to the broker on the <span className="mono">/brokers</span> page (Mosquitto does
                not expose per-client identity over <span className="mono">$SYS</span>). Leave blank to show only the client
                count and gateway roster. Not a secret.
              </p>
            </label>
            <div className="flex flex-wrap items-center gap-4 md:col-span-2">
              <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> enabled</label>
              <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={form.tls_enabled} onChange={(e) => set({ tls_enabled: e.target.checked })} /> TLS</label>
              <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={form.tls_insecure} onChange={(e) => set({ tls_insecure: e.target.checked })} /> skip cert verify</label>
              <label className="flex items-center gap-2 text-[13px] text-ink-mute">QoS
                <select className="h-8 rounded-md border border-line bg-raised px-2 text-[13px]" value={form.qos} onChange={(e) => set({ qos: Number(e.target.value) })}>
                  <option value={0}>0</option><option value={1}>1</option><option value={2}>2</option>
                </select>
              </label>
            </div>
            <div className="flex gap-2 md:col-span-2">
              <button className="btn btn-primary h-9 px-4 text-[13px]" type="submit">Save broker</button>
              <button className="btn btn-outline h-9 px-4 text-[13px]" type="button" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        )}
      </div>

      {/* Channel keys */}
      <div className="card">
        <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Channel keys</h2>
        <table className="data">
          <thead><tr><th>Name</th><th>Key</th><th></th></tr></thead>
          <tbody>
            {keys.length === 0 && <tr><td colSpan={3} className="text-ink-faint">No keys.</td></tr>}
            {keys.map((k) => (
              <tr key={k.name}>
                <td className="mono">{k.name}</td>
                <td className="text-ink-mute">{k.has_key ? <span className="pill pill-on">set</span> : <span className="pill pill-off">none</span>}</td>
                <td className="text-right"><button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => deleteKey(k.name)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4" onSubmit={addKey}>
          <label className="space-y-1"><span className="block stat-label">Name</span>
            <input className={inputCls + " w-40"} value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="default" />
          </label>
          <label className="flex-1 space-y-1"><span className="block stat-label">Key (base64)</span>
            <input className={inputCls} value={keyVal} onChange={(e) => setKeyVal(e.target.value)} placeholder="AQ==" />
          </label>
          <button className="btn btn-primary h-9 px-4 text-[13px]" type="submit">Add key</button>
        </form>
      </div>
    </div>
  );
}
