"use client";

import { useEffect, useState } from "react";
import { formatNodeId } from "../meshtastic/types.ts";
import { NodeConfigEditor } from "./NodeConfigEditor.tsx";

export interface TxSettings {
  enabled: boolean; armed: boolean; dry_run: boolean; transport: "mqtt" | "node"; broker_id: string;
  default_hop_limit: number; max_hop_limit: number;
  rate_limit: { per_minute: number; per_hour: number };
  max_channel_util: number; from_node: number; ok_to_mqtt: boolean;
  node_long_name: string; node_short_name: string;
  announce_interval_s: number; traceroute_cooldown_s: number;
  auto_responder: { enabled: boolean; cooldown_s: number; respond_to_dm: boolean; respond_to_channel: boolean; reply_channel: string; reply_transport?: "match" | "both" | "fixed"; triggers: { pattern: string; reply: string; reply_mqtt?: string; reply_via?: "match" | "dm" | "channel" }[] };
  auto_traceroute: { enabled: boolean; send_every_minutes: number; interval_hours: number; max_per_run: number; max_active_age_hours: number; transport: "rf" | "mqtt"; only_routers: boolean };
  admin_scanner: { enabled: boolean; interval_hours: number; max_per_run: number; max_active_age_hours: number; reconfirm_hours: number };
  canned_messages: string[];
}
interface OutboxRow {
  id: number; created_at: string; created_by: string; kind: string; channel_id: string | null;
  to_node: number | null; state: string; packet_id: number | null; error: string | null; transport?: string;
}
export interface NodeDbMaint { enabled: boolean; interval_hours: number; stale_days: number; favorite_repeaters: boolean }
export interface NodeConn { host: string; port: number; rx_enabled: boolean; nodedb_maint?: NodeDbMaint }

const NODEDB_MAINT_DEFAULT: NodeDbMaint = { enabled: false, interval_hours: 24, stale_days: 7, favorite_repeaters: true };
interface NodeSnapshot {
  host: string; port: number; my_node_num: number | null; my_node_id: string | null;
  metadata: { firmware_version: string; hw_model?: string; role?: string; has_wifi: boolean; has_bluetooth: boolean } | null;
  config: Record<string, Record<string, unknown>>; module_config: Record<string, Record<string, unknown>>;
  channels: { index: number; role: string; name: string; label?: string; encrypted: boolean; uplink: boolean; downlink: boolean }[];
  nodes: { num: number; node_id: string; long_name?: string; short_name?: string; hw_model?: string; role?: string; last_heard: number }[];
  complete: boolean;
}

const inputCls = "h-9 w-28 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";
const STATE_TONE: Record<string, string> = {
  queued: "text-ink-mute", held: "text-accent-strong", dry_run: "text-ink-faint", sent: "text-accent",
  heard: "text-ok", acked: "text-ok", failed: "text-accent-strong", cancelled: "text-ink-faint",
};

export function TxManager({ initial, initialNode, initialOutbox, brokers = [], zone = "UTC" }: { initial: TxSettings; initialNode: NodeConn; initialOutbox: OutboxRow[]; brokers?: { id: string; host: string }[]; zone?: string }) {
  // TX debug log timestamps are stored UTC; render them in the server-configured timezone.
  const fmtLogTime = (utc: string) => {
    try { return new Intl.DateTimeFormat(undefined, { timeZone: zone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(utc.replace(" ", "T") + "Z")); }
    catch { return utc.slice(5, 19).replace("T", " "); }
  };
  const [s, setS] = useState<TxSettings>(initial);
  const [node, setNode] = useState<NodeConn>(initialNode);
  const [outbox, setOutbox] = useState<OutboxRow[]>(initialOutbox);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<NodeSnapshot | null>(null);
  const [reading, setReading] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [nodeMsg, setNodeMsg] = useState<string | null>(null);
  const [log, setLog] = useState<{ id: number; created_at: string; outbox_id: number | null; level: string; message: string }[]>([]);

  // Poll the queue + debug log so state (queued -> sent -> heard -> acked) and the send trace
  // update live without shell access.
  useEffect(() => {
    const pull = async () => {
      const [o, l] = await Promise.all([
        fetch("/api/v1/tx/outbox?limit=50").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/v1/tx/log?limit=150").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (o) setOutbox(o.outbox ?? []);
      if (l) setLog(l.log ?? []);
    };
    void pull();
    const t = setInterval(() => void pull(), 5000);
    return () => clearInterval(t);
  }, []);

  async function saveConfig() {
    setMsg(null); setError(null);
    const r = await fetch("/api/v1/admin/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...s, node }) });
    if (r.ok) setMsg("Saved. The worker picks up changes within about 10 seconds.");
    else setError((await r.json().catch(() => ({}))).error ?? "save failed");
  }
  async function readNodeConfig() {
    setReading(true); setNodeMsg(null); setSnapshot(null);
    const r = await fetch("/api/v1/admin/node/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host: node.host, port: node.port, save: true }) });
    const d = await r.json().catch(() => ({}));
    setReading(false);
    if (r.ok) { setSnapshot(d.snapshot); setNodeMsg(d.snapshot?.complete ? "Config read complete." : "Partial read (node did not signal complete)."); }
    else setNodeMsg(d.error ?? "read failed");
  }
  /**
   * Force the RF receive stream to reconnect immediately.
   *
   * Not a transmit, so it is not gated by the arm state: it only drops and reopens the receive
   * socket. Useful after power-cycling the node, because the connector otherwise sits out its
   * exponential backoff (up to 30s between attempts) before trying again.
   */
  async function reconnectNode() {
    setReconnecting(true); setNodeMsg(null);
    const r = await fetch("/api/v1/admin/node/reconnect", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setReconnecting(false);
    setNodeMsg(r.ok ? (d.note ?? "Reconnecting...") : (d.error ?? "reconnect failed"));
  }
  const maint = node.nodedb_maint ?? NODEDB_MAINT_DEFAULT;
  const setMaint = (patch: Partial<NodeDbMaint>) => setNode({ ...node, nodedb_maint: { ...maint, ...patch } });
  async function pruneNow() {
    setPruning(true); setNodeMsg(null);
    const r = await fetch("/api/v1/admin/node/nodedb-prune", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setPruning(false);
    if (r.ok) { const x = d.result; setNodeMsg(x ? `Prune done: ${x.total} in DB, favorited ${x.favorited}, removed ${x.removed}, kept ${x.kept}.` : "Prune ran."); }
    else setNodeMsg(d.error ?? "prune failed");
  }
  async function arm(on: boolean) {
    setMsg(null); setError(null);
    const r = await fetch(`/api/v1/admin/tx/${on ? "arm" : "disarm"}`, { method: "POST" });
    if (r.ok) { setS({ ...s, armed: on }); setMsg(on ? "Armed." : "Disarmed. Queue halts on the next worker tick."); }
    else setError((await r.json().catch(() => ({}))).error ?? "failed");
  }
  async function refreshOutbox() {
    const r = await fetch("/api/v1/tx/outbox?limit=50");
    if (r.ok) setOutbox((await r.json()).outbox ?? []);
  }
  async function cancel(id: number) {
    await fetch(`/api/v1/tx/outbox/${id}/cancel`, { method: "POST" });
    await refreshOutbox();
  }
  // Cancel every queued/held row at once, so the queue can be emptied before arming.
  async function clearQueued() {
    const pending = outbox.filter((o) => o.state === "queued" || o.state === "held");
    if (pending.length === 0) return;
    if (!confirm(`Cancel ${pending.length} queued message(s)?`)) return;
    await Promise.all(pending.map((o) => fetch(`/api/v1/tx/outbox/${o.id}/cancel`, { method: "POST" }).catch(() => {})));
    await refreshOutbox();
  }

  const queuedCount = outbox.filter((o) => o.state === "queued" || o.state === "held").length;
  const setNum = (k: keyof TxSettings, v: string) => setS({ ...s, [k]: Number(v) });

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Transmit (TX)</h2>
        <div className="flex items-center gap-3">
          {s.from_node <= 0 && <span className="text-[11px] text-accent-strong">set a From node below to arm</span>}
          {s.from_node > 0 && !s.enabled && <span className="text-[11px] text-accent-strong">tick Enabled and Save before arming</span>}
          {error && <span className="text-[11px] text-accent-strong">{error}</span>}
          <label className="flex cursor-pointer items-center gap-2" title={s.from_node <= 0 ? "Set tx.from_node first" : !s.enabled ? "Enable TX and Save first" : "Arm / disarm transmit"}>
            <span className={`text-[12px] ${s.armed ? "text-ok font-semibold" : "text-ink-faint"}`}>{s.armed ? "ARMED" : "disarmed"}</span>
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={s.armed} disabled={s.from_node <= 0 || !s.enabled} onChange={(e) => arm(e.target.checked)} />
          </label>
        </div>
      </div>
      <p className="text-[12px] text-ink-faint">
        Passive by default. Transmitting needs TX enabled AND armed AND dry-run off. Disarm is
        the kill switch. All sends are rate limited, mute-aware, and audited below.
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Enabled</label>
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.dry_run} onChange={(e) => setS({ ...s, dry_run: e.target.checked })} /> Dry-run (encode only, never publish)</label>
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.ok_to_mqtt} onChange={(e) => setS({ ...s, ok_to_mqtt: e.target.checked })} /> Set OK-to-MQTT on our packets (lets gateways uplink our traffic)</label>
        <label className="flex items-center gap-2 text-[13px] text-ink">Transport
          <select value={s.transport} onChange={(e) => setS({ ...s, transport: e.target.value as "mqtt" | "node" })} className="h-8 rounded-md border border-line bg-raised px-2 text-[13px] text-ink">
            <option value="mqtt">MQTT (downlink topic)</option>
            <option value="node">Station node (direct)</option>
          </select>
        </label>
        {s.transport === "mqtt" && (
          <label className="flex items-center gap-2 text-[13px] text-ink">MQTT broker
            <select value={s.broker_id} onChange={(e) => setS({ ...s, broker_id: e.target.value })} className="h-8 rounded-md border border-line bg-raised px-2 text-[13px] text-ink">
              <option value="">first enabled</option>
              {brokers.map((b) => <option key={b.id} value={b.id}>{b.id} ({b.host})</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="text-[11px] text-ink-faint">
        <strong>Transport</strong> = how a queued message reaches the air.
        <span className="mono"> MQTT</span>: publish to your broker&apos;s downlink topic and let a downlink-enabled
        gateway put it on RF (indirect). <span className="mono">Station node (direct)</span>: send straight to your
        connected node (below), which transmits it on RF itself. <span className="mono">Enabled</span> is the master
        switch; <span className="mono">Dry-run</span> encodes everything but publishes nothing (safe testing).
      </p>

      {/* Station node: direct TCP link to a local Meshtastic node's stream API (port 4403). */}
      <div className="space-y-2 rounded-md border border-line p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="stat-label w-full">Station node connection {s.transport === "node" ? <span className="text-ok">(active transport)</span> : <span className="text-ink-faint">(used when transport = station node)</span>}</div>
          <label className="space-y-1"><span className="block stat-label">Node IP / host</span><input value={node.host} onChange={(e) => setNode({ ...node, host: e.target.value })} placeholder="192.168.1.50" className="h-9 w-48 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none" /></label>
          <label className="space-y-1"><span className="block stat-label">Port</span><input type="number" value={String(node.port)} onChange={(e) => setNode({ ...node, port: Number(e.target.value) })} className={inputCls} /></label>
          <button className="btn btn-outline h-9 px-3 text-[13px]" disabled={reading || !node.host} onClick={readNodeConfig}>{reading ? "Reading..." : "Read config from node"}</button>
          <button className="btn btn-outline h-9 px-3 text-[13px]" disabled={reconnecting || !node.host || !node.rx_enabled} onClick={reconnectNode} title={!node.rx_enabled ? "Enable RF receive below first" : "Drop and reopen the RF receive stream now, skipping the reconnect backoff"}>{reconnecting ? "Connecting..." : "Connect now"}</button>
          {nodeMsg && <span className={`text-[12px] ${snapshot ? "text-ok" : "text-accent-strong"}`}>{nodeMsg}</span>}
          <label className="flex w-full items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={node.rx_enabled} onChange={(e) => setNode({ ...node, rx_enabled: e.target.checked })} /> Ingest this node&apos;s RF receptions (transport = rf). Save to apply; the ingest daemon connects within ~5s.</label>
          <p className="w-full text-[11px] text-ink-faint">
            The receive stream reconnects on its own with exponential backoff (1s, 2s, 4s, 8s, 16s,
            then every 30s), so a node that has been down a while can leave a 30s wait before the
            next attempt. &quot;Connect now&quot; skips that wait; the ingest daemon acts on it within
            about a second. It is a receive-side action only and does not transmit.
          </p>
        </div>
        <p className="text-[11px] text-ink-faint">Pulls the node&apos;s config, channels, and node DB over its stream API (like MeshMonitor). Read-only: it never transmits over RF. Saving stores this connection for the station-node transport.</p>

        {/* NodeDB maintenance: keep a RAM-constrained node from overfilling and reboot-looping. */}
        <div className="space-y-2 rounded-md border border-line p-3">
          <div className="stat-label">NodeDB maintenance</div>
          <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={maint.enabled} onChange={(e) => setMaint({ enabled: e.target.checked })} /> Automatically prune the node&apos;s on-device NodeDB</label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1"><span className="block stat-label">Every (hours)</span><input type="number" min={1} value={String(maint.interval_hours)} onChange={(e) => setMaint({ interval_hours: Number(e.target.value) })} className={inputCls} /></label>
            <label className="space-y-1"><span className="block stat-label">Remove nodes not heard in (days)</span><input type="number" min={1} value={String(maint.stale_days)} onChange={(e) => setMaint({ stale_days: Number(e.target.value) })} className={`${inputCls} w-52`} /></label>
            <label className="flex items-center gap-2 pb-2 text-[13px] text-ink-mute"><input type="checkbox" checked={maint.favorite_repeaters} onChange={(e) => setMaint({ favorite_repeaters: e.target.checked })} /> favorite repeaters/routers (never pruned)</label>
            <button className="btn btn-outline h-9 px-3 text-[13px]" disabled={pruning || !node.host} onClick={pruneNow} title="Read the node DB and prune it now (favorite repeaters, remove stale)">{pruning ? "Pruning..." : "Prune now"}</button>
          </div>
          <p className="text-[11px] text-ink-faint">
            Keeps the station node&apos;s NodeDB trimmed so a RAM-constrained board (ESP32) does not overfill and reboot-loop.
            Favorited repeaters/routers are protected from both this prune and the firmware&apos;s own eviction. Runs over the
            node admin API (like config writes), not an RF transmit. Save to apply the schedule; &quot;Prune now&quot; runs once immediately.
          </p>
        </div>
        {snapshot && <NodeConfigView snap={snapshot} onUseAsFrom={(n) => setS({ ...s, from_node: n })} />}
        {snapshot && <NodeConfigEditor snap={snapshot} host={node.host} port={node.port} onWritten={(sn) => setSnapshot(sn as NodeSnapshot)} />}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="space-y-1"><span className="block stat-label">From node (u32, required to arm)</span>
          <input type="number" value={String(s.from_node)} onChange={(e) => setNum("from_node", e.target.value)} className={inputCls} />
          <span className="block text-[11px] text-ink-faint">{s.from_node > 0 ? formatNodeId(s.from_node) : "unset"}</span>
        </label>
        <label className="space-y-1"><span className="block stat-label">Max hop limit</span><input type="number" value={String(s.max_hop_limit)} onChange={(e) => setNum("max_hop_limit", e.target.value)} className={inputCls} /></label>
        <label className="space-y-1"><span className="block stat-label">Rate /min</span><input type="number" value={String(s.rate_limit.per_minute)} onChange={(e) => setS({ ...s, rate_limit: { ...s.rate_limit, per_minute: Number(e.target.value) } })} className={inputCls} /></label>
        <label className="space-y-1"><span className="block stat-label">Rate /hour</span><input type="number" value={String(s.rate_limit.per_hour)} onChange={(e) => setS({ ...s, rate_limit: { ...s.rate_limit, per_hour: Number(e.target.value) } })} className={inputCls} /></label>
        <label className="space-y-1"><span className="block stat-label">Max channel util %</span><input type="number" value={String(s.max_channel_util)} onChange={(e) => setNum("max_channel_util", e.target.value)} className={inputCls} /></label>
        <label className="space-y-1"><span className="block stat-label">Announce name</span><input value={s.node_long_name} onChange={(e) => setS({ ...s, node_long_name: e.target.value })} className={inputCls} /></label>
        <label className="space-y-1"><span className="block stat-label">Short name</span><input value={s.node_short_name} onChange={(e) => setS({ ...s, node_short_name: e.target.value })} className={inputCls} /></label>
        <label className="space-y-1"><span className="block stat-label">Announce every (s, 0=off)</span><input type="number" value={String(s.announce_interval_s)} onChange={(e) => setNum("announce_interval_s", e.target.value)} className={inputCls} /></label>
      </div>

      <div className="space-y-1">
        <span className="stat-label">Canned messages (one per line) - shown as one-tap buttons in the Messages compose box</span>
        <textarea
          className="min-h-16 w-full rounded-md border border-line bg-raised px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none"
          value={s.canned_messages.join("\n")}
          onChange={(e) => setS({ ...s, canned_messages: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })}
          placeholder={"on my way\nnet starting now\nradio check?"}
        />
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={saveConfig}>Save settings</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {error && <span className="text-[12px] text-accent-strong">{error}</span>}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between" id="outbox">
          <span className="stat-label">Outbox / audit log{queuedCount > 0 ? ` - ${queuedCount} queued` : ""}</span>
          {queuedCount > 0 && <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={clearQueued}>Clear queued ({queuedCount})</button>}
        </div>
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>ID</th><th>Kind</th><th>To</th><th>Channel</th><th>Via</th><th>By</th><th>State</th><th>Detail</th><th></th></tr></thead>
            <tbody>
              {outbox.length === 0 && <tr><td colSpan={9} className="text-ink-faint">Nothing queued yet.</td></tr>}
              {outbox.map((o) => (
                <tr key={o.id}>
                  <td className="tabular-nums text-ink-faint">{o.id}</td>
                  <td>{o.kind}</td>
                  <td className="mono text-ink-faint">{o.to_node != null ? formatNodeId(o.to_node) : "broadcast"}</td>
                  <td className="text-ink-faint">{o.channel_id ?? "-"}</td>
                  <td className="text-ink-faint">{o.transport === "node" ? "node (RF)" : o.transport ?? "-"}</td>
                  <td className="text-ink-faint">{o.created_by}</td>
                  <td className={STATE_TONE[o.state] ?? "text-ink"}>{o.state}</td>
                  <td className="max-w-[240px] truncate text-[11px] text-accent-strong" title={o.error ?? ""}>{o.error ?? ""}</td>
                  <td className="text-right">{(o.state === "queued" || o.state === "held") && <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => cancel(o.id)}>Cancel</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="stat-label">TX debug log</span>
          <span className="text-[11px] text-ink-faint">live send trace (worker); updates every 5s, kept 3 days</span>
        </div>
        <div className="max-h-72 overflow-auto rounded-md border border-line bg-raised/40 p-2 font-mono text-[11px] leading-relaxed">
          {log.length === 0 && <p className="text-ink-faint">No TX activity logged yet. Send a message and the pipeline trace appears here.</p>}
          {log.map((l) => (
            <div key={l.id} className={l.level === "error" ? "text-accent-strong" : l.level === "warn" ? "text-accent" : "text-ink-mute"}>
              <span className="text-ink-faint">{fmtLogTime(l.created_at)}</span>{" "}
              {l.outbox_id != null && <span className="text-ink-faint">#{l.outbox_id}</span>} {l.message}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const kv = (v: unknown) => (typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

function NodeConfigView({ snap, onUseAsFrom }: { snap: NodeSnapshot; onUseAsFrom: (n: number) => void }) {
  const lora = snap.config.lora ?? {};
  const device = snap.config.device ?? {};
  return (
    <div className="mt-2 space-y-3 border-t border-line pt-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        {snap.my_node_id && (
          <span className="text-ink-mute">Node <span className="mono text-ink">{snap.my_node_id}</span>
            {snap.my_node_num != null && <button className="btn btn-outline ml-2 h-6 px-2 text-[11px]" onClick={() => onUseAsFrom(snap.my_node_num!)}>Use as TX from-node</button>}
          </span>
        )}
        {snap.metadata && <span className="text-ink-mute">Firmware <span className="text-ink">{snap.metadata.firmware_version || "?"}</span></span>}
        {snap.metadata?.hw_model && <span className="text-ink-mute">HW <span className="text-ink">{snap.metadata.hw_model}</span></span>}
        {(device.role || snap.metadata?.role) && <span className="text-ink-mute">Role <span className="text-ink">{String(device.role ?? snap.metadata?.role)}</span></span>}
        {snap.metadata && <span className="text-ink-faint">{snap.metadata.has_wifi ? "WiFi " : ""}{snap.metadata.has_bluetooth ? "BT" : ""}</span>}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-ink-mute">
        <span>Region <span className="text-ink">{kv(lora.region ?? "?")}</span></span>
        <span>Preset <span className="text-ink">{kv(lora.modem_preset ?? "?")}</span></span>
        <span>Hop limit <span className="text-ink">{kv(lora.hop_limit ?? "?")}</span></span>
        <span>TX <span className="text-ink">{lora.tx_enabled === false ? "disabled" : "enabled"}</span></span>
        {lora.tx_power != null && <span>TX power <span className="text-ink">{kv(lora.tx_power)}</span></span>}
      </div>

      {snap.channels.length > 0 && (
        <div>
          <div className="stat-label mb-1">Channels ({snap.channels.length})</div>
          <div className="overflow-x-auto"><table className="data">
            <thead><tr><th>#</th><th>Name</th><th>Role</th><th>Encrypted</th><th>MQTT up/down</th></tr></thead>
            <tbody>{snap.channels.map((c) => (
              <tr key={c.index}><td className="tabular-nums">{c.index}</td><td className="text-ink">{c.label ?? c.name}</td><td className="text-ink-faint">{c.role}</td><td>{c.encrypted ? "yes" : "no"}</td><td className="text-ink-faint">{c.uplink ? "up" : "-"} / {c.downlink ? "down" : "-"}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      {snap.nodes.length > 0 && (
        <details>
          <summary className="cursor-pointer stat-label">Node DB ({snap.nodes.length})</summary>
          <div className="mt-1 max-h-72 overflow-auto"><table className="data">
            <thead><tr><th>Node</th><th>Name</th><th>Short</th><th>HW</th><th>Role</th></tr></thead>
            <tbody>{snap.nodes.map((n) => (
              <tr key={n.num}><td className="mono text-ink-faint">{n.node_id}</td><td className="text-ink">{n.long_name ?? "-"}</td><td className="text-ink-faint">{n.short_name ?? "-"}</td><td className="text-ink-faint">{n.hw_model ?? "-"}</td><td className="text-ink-faint">{n.role ?? "-"}</td></tr>
            ))}</tbody>
          </table></div>
        </details>
      )}

      {(Object.keys(snap.module_config).length > 0) && (
        <details>
          <summary className="cursor-pointer stat-label">Module config ({Object.keys(snap.module_config).length})</summary>
          <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(snap.module_config).map(([sec, vals]) => (
              // Every key, scrollable. A fixed 8-key slice silently hid the rest of each section,
              // so the "raw dump" an operator reaches for when something is misconfigured was not
              // actually a dump: the field they were looking for was usually past the cut.
              <div key={sec} className="rounded border border-line p-2">
                <div className="font-medium text-ink">{sec} <span className="text-ink-faint">({Object.keys(vals).length})</span></div>
                <div className="max-h-48 overflow-y-auto">
                  {Object.entries(vals).map(([k, v]) => <div key={k} className="flex justify-between gap-2 text-ink-faint"><span>{k}</span><span className="text-ink-mute">{kv(v)}</span></div>)}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
