"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "../lib/cn.ts";
import { formatNodeId } from "../meshtastic/types.ts";

// bridge_log carries both sanctioned bridges: MQTT-to-MQTT federation (out/in) and the RF<->MQTT
// patcher, whose refusals are recorded too so a message that was NOT bridged is visible with its
// reason rather than only appearing in the worker log.
const DIR_LABEL: Record<string, string> = {
  out: "local to peer", in: "peer to local",
  rf_to_mqtt: "RF to MQTT", mqtt_to_rf: "MQTT to RF", skip: "not bridged",
};
const DIR_CLASS: Record<string, string> = {
  out: "text-accent", in: "text-ok", rf_to_mqtt: "text-ok", mqtt_to_rf: "text-accent", skip: "text-accent-strong",
};

export interface BridgeSettings {
  enabled: boolean; armed: boolean; text_only: boolean; require_ok_to_mqtt: boolean;
  direction: "both" | "out" | "in"; channels: string[];
  local_broker_id: string; peer_broker_ids: string[];
  rf_to_mqtt: boolean; mqtt_to_rf: boolean; patch_hold_seconds: number;
}
interface Broker { id: string; host: string; root: string; rootSource: "explicit" | "derived" | "none" }
interface LogRow {
  id: number; bridged_at: string; direction: "out" | "in" | "rf_to_mqtt" | "mqtt_to_rf" | "skip"; from_broker: string | null; to_broker: string | null;
  from_node_id: number | null; mesh_packet_id: number | null; channel_id: string | null; topic: string | null; dest_topic: string | null;
}

const inp = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

export function BridgeManager({ initial, brokers, channels, initialLog, zone }: { initial: BridgeSettings; brokers: Broker[]; channels: string[]; initialLog: LogRow[]; zone: string }) {
  const [s, setS] = useState<BridgeSettings>(initial);
  const [log, setLog] = useState<LogRow[]>(initialLog);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const peers = brokers.filter((b) => b.id !== s.local_broker_id);
  const togglePeer = (id: string) => setS((p) => ({ ...p, peer_broker_ids: p.peer_broker_ids.includes(id) ? p.peer_broker_ids.filter((x) => x !== id) : [...p.peer_broker_ids, id] }));
  const toggleChannel = (c: string) => setS((p) => ({ ...p, channels: p.channels.includes(c) ? p.channels.filter((x) => x !== c) : [...p.channels, c] }));

  // Live preview of how topics get rewritten, so it is obvious what maps to what. The rewrite
  // keeps the "/2/e/<channel>/<gateway>" suffix and swaps the leading root to the destination
  // broker's root (its explicit Root topic, or one derived from its first subscribe topic).
  const local = brokers.find((b) => b.id === s.local_broker_id) ?? null;
  const selectedPeers = brokers.filter((b) => s.peer_broker_ids.includes(b.id));
  const SUFFIX = "/2/e/LongFast/!gateway"; // illustrative; the real channel/gateway are preserved
  const rewrites: { dir: "out" | "in"; from: Broker; to: Broker }[] = [];
  if (local) {
    for (const p of selectedPeers) {
      if (s.direction !== "in") rewrites.push({ dir: "out", from: local, to: p });
      if (s.direction !== "out") rewrites.push({ dir: "in", from: p, to: local });
    }
  }
  const rootBadge = (b: Broker) => b.rootSource === "explicit"
    ? <span className="pill pill-on">root set</span>
    : b.rootSource === "derived"
      ? <span className="pill pill-off" title="Derived from the broker's first subscribe topic. Set an explicit Root topic if the broker has multiple region roots.">derived</span>
      : <span className="pill" style={{ color: "var(--color-accent-strong)" }} title="No Root topic and none derivable; messages bridged to this broker keep their original topic.">no root</span>;

  async function save() {
    setMsg(null); setError(null);
    const r = await fetch("/api/v1/admin/bridge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(s) });
    if (r.ok) {
      setMsg("Saved. The ingest daemon picks up bridge changes within ~5s.");
      const g = await fetch("/api/v1/admin/bridge").then((x) => x.json()).catch(() => null);
      if (g?.log) setLog(g.log);
    } else setError((await r.json().catch(() => ({}))).error ?? "save failed");
  }

  const fmtAge = (iso: string) => { try { return new Date(iso.replace(" ", "T") + "Z").toLocaleString(); } catch { return iso; } };

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow"><span className="eyebrow-bar" />MQTT text bridge</h2>
        <span className={cn("pill", s.enabled && s.armed ? "pill-on" : "pill-off")}>{s.enabled && s.armed ? "armed" : s.enabled ? "enabled, disarmed" : "off"}</span>
      </div>
      <p className="text-[12px] text-ink-faint">
        Forwards only text messages (LongFast-style chat) between your local broker and peer brokers,
        and only packets whose sender set the OK-to-MQTT bit. No telemetry, position, or nodeinfo is
        bridged. Both Enabled and Armed must be on; disarm is the kill switch. Add the peer brokers under{" "}
        <Link className="text-accent hover:underline" href="/admin/settings">ingest settings</Link> first so their traffic is also received.
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Enabled</label>
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.armed} onChange={(e) => setS({ ...s, armed: e.target.checked })} /> Armed (kill switch)</label>
        <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={s.text_only} onChange={(e) => setS({ ...s, text_only: e.target.checked })} /> Text messages only</label>
        <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={s.require_ok_to_mqtt} onChange={(e) => setS({ ...s, require_ok_to_mqtt: e.target.checked })} /> Require OK-to-MQTT</label>
      </div>
      <p className="text-[11px] text-ink-faint">
        <b>Require OK-to-MQTT</b> (on by default) governs BOTH the MQTT federation bridge and the
        RF&rarr;MQTT uplink: only messages whose sender set the OK-to-MQTT bit are republished.
        Turning it off uplinks senders who did <b>not</b> consent. That is fine for a <b>private</b>
        broker you control, but on the public Meshtastic MQTT it republishes traffic from people who
        opted out, which is what the bit exists to prevent. Either way HopWatch never forges the bit:
        a re-published copy carries the sender&apos;s real value, so a downstream gateway that honours
        it will not propagate it onward.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1"><span className="block stat-label">Local broker (ours)</span>
          <select className={`${inp} w-48`} value={s.local_broker_id} onChange={(e) => setS({ ...s, local_broker_id: e.target.value, peer_broker_ids: s.peer_broker_ids.filter((x) => x !== e.target.value) })}>
            <option value="">(select)</option>
            {brokers.map((b) => <option key={b.id} value={b.id}>{b.id} ({b.host})</option>)}
          </select>
        </label>
        <div className="space-y-1">
          <span className="block stat-label">Peer brokers to bridge with</span>
          <div className="flex flex-wrap gap-3">
            {peers.length === 0 ? <span className="text-[12px] text-ink-faint">no other brokers configured</span>
              : peers.map((b) => (
                <label key={b.id} className="flex items-center gap-1.5 text-[13px] text-ink-mute">
                  <input type="checkbox" checked={s.peer_broker_ids.includes(b.id)} onChange={() => togglePeer(b.id)} /> {b.id}
                </label>
              ))}
          </div>
        </div>
        <label className="space-y-1"><span className="block stat-label">Direction</span>
          <select className={`${inp} w-48`} value={s.direction} onChange={(e) => setS({ ...s, direction: e.target.value as BridgeSettings["direction"] })}>
            <option value="both">Both ways</option>
            <option value="out">Local to peers only</option>
            <option value="in">Peers to local only</option>
          </select>
        </label>
      </div>

      <div className="space-y-1">
        <span className="block stat-label">Channels to bridge (none checked = all decodable text channels)</span>
        <div className="flex flex-wrap gap-3">
          {channels.length === 0 ? <span className="text-[12px] text-ink-faint">no channels seen yet</span>
            : channels.map((c) => (
              <label key={c} className="flex items-center gap-1.5 text-[13px] text-ink-mute">
                <input type="checkbox" checked={s.channels.includes(c)} onChange={() => toggleChannel(c)} /> {c}
              </label>
            ))}
        </div>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="stat-label">RF cross-link (station node)</div>
        <p className="text-[12px] text-ink-faint">
          Patch text between RF (your station node) and MQTT, like a Meshtastic gateway. RF-heard text is
          uplinked faithfully (original sender preserved); MQTT-heard text is <strong>re-originated as HopWatch&apos;s
          own TX node</strong> onto RF via the armed TX outbox (never spoofs a sender). A hold timer skips anything
          already carried across on its own, so it will not double with your node&apos;s native LongFast bridging.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.rf_to_mqtt} onChange={(e) => setS({ ...s, rf_to_mqtt: e.target.checked })} /> RF &rarr; MQTT uplink (needs node RX)</label>
          <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.mqtt_to_rf} onChange={(e) => setS({ ...s, mqtt_to_rf: e.target.checked })} /> MQTT &rarr; RF transmit (needs TX armed)</label>
          <label className="flex items-center gap-2 text-[13px] text-ink-mute">Hold timer
            <input type="number" min={3} max={600} value={String(s.patch_hold_seconds)} onChange={(e) => setS({ ...s, patch_hold_seconds: Number(e.target.value) })} className={`${inp} w-20`} /> s
          </label>
        </div>
        {s.mqtt_to_rf && <p className="text-[11px] text-accent-strong">MQTT &rarr; RF keys up your radio. It only sends when the TX subsystem is enabled + armed (dry-run first), through the same rate limits, channel-util guard, and audit log as all other TX.</p>}
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="stat-label">Topic rewrite (what gets republished where)</div>
        {!local ? (
          <p className="text-[12px] text-ink-faint">Select a local broker and at least one peer to preview the rewrites.</p>
        ) : rewrites.length === 0 ? (
          <p className="text-[12px] text-ink-faint">Select at least one peer broker above.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-mute">
              {[local, ...selectedPeers].map((b) => (
                <span key={b.id} className="inline-flex items-center gap-1.5">
                  {b.id} {rootBadge(b)} <span className="mono text-ink-faint">{b.root || "(none)"}</span>
                </span>
              ))}
            </div>
            <div className="space-y-1">
              {rewrites.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className={r.dir === "out" ? "text-accent" : "text-ok"}>{r.dir === "out" ? "local to peer" : "peer to local"}</span>
                  <span className="mono text-ink-faint">{(r.from.root || r.from.id) + SUFFIX}</span>
                  <span className="text-ink-faint">&rarr;</span>
                  <span className="mono text-ink">{(r.to.root ? r.to.root + SUFFIX : `(unchanged: ${r.from.root || r.from.id}${SUFFIX})`)}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-ink-faint">
              The <span className="mono">/2/e/&lt;channel&gt;/&lt;gateway&gt;</span> suffix is illustrative; the real channel and
              gateway from each message are preserved. Only the leading root changes. A broker marked
              <span className="mx-1 pill pill-off">derived</span> infers its root from its first subscribe topic; if it carries
              multiple region roots, set an explicit <span className="mono">Root topic</span> on its broker config so the mapping is unambiguous.
            </p>
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save bridge settings</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {error && <span className="text-[12px] text-accent-strong">{error}</span>}
      </div>

      <div className="border-t border-line pt-3">
        <div className="stat-label mb-2">Recent bridged messages ({zone})</div>
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>When</th><th>Dir</th><th>From</th><th>To</th><th>Node</th><th>Channel</th><th>Source topic</th><th>Dest topic</th></tr></thead>
            <tbody>
              {log.length === 0 && <tr><td colSpan={8} className="text-ink-faint">Nothing bridged yet.</td></tr>}
              {log.map((l) => (
                <tr key={l.id}>
                  <td className="text-ink-mute">{fmtAge(l.bridged_at)}</td>
                  <td className={DIR_CLASS[l.direction] ?? "text-ink-mute"}>{DIR_LABEL[l.direction] ?? l.direction}</td>
                  <td className="mono text-ink-mute">{l.from_broker}</td>
                  <td className="mono text-ink-mute">{l.to_broker}</td>
                  <td className="mono">{l.from_node_id ? formatNodeId(l.from_node_id) : "-"}</td>
                  <td className="text-ink-mute">{l.channel_id ?? "-"}</td>
                  <td className="mono max-w-[240px] truncate text-[11px] text-ink-faint" title={l.topic ?? ""}>{l.topic ?? "-"}</td>
                  <td className="mono max-w-[240px] truncate text-[11px] text-ink-faint" title={l.dest_topic ?? ""}>{l.dest_topic ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
