"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "../lib/cn.ts";
import { formatNodeId } from "../meshtastic/types.ts";

export interface FeedSettings {
  enabled: boolean; armed: boolean; broker_id: string; topic_suffix: string;
  require_ok_to_mqtt: boolean; public_only: boolean; all_regions: boolean; include_reactions: boolean;
  channels: string[]; max_text_chars: number;
}
interface Broker { id: string; host: string; root: string; rootSource: "explicit" | "derived" | "none" }
interface LogRow {
  id: number; bridged_at: string; from_broker: string | null; to_broker: string | null;
  from_node_id: number | null; mesh_packet_id: number | null; channel_id: string | null; dest_topic: string | null;
}

const inp = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

export function TextFeedManager({ initial, brokers, channels, initialLog, zone }: { initial: FeedSettings; brokers: Broker[]; channels: string[]; initialLog: LogRow[]; zone: string }) {
  const [s, setS] = useState<FeedSettings>(initial);
  const [log, setLog] = useState<LogRow[]>(initialLog);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleChannel = (c: string) => setS((p) => ({ ...p, channels: p.channels.includes(c) ? p.channels.filter((x) => x !== c) : [...p.channels, c] }));
  const target = brokers.find((b) => b.id === s.broker_id) ?? null;
  const suffix = (s.topic_suffix || "hopwatch/v1/text").replace(/^\/+|\/+$/g, "");
  const destTopic = target?.root ? `${target.root}/${suffix}` : null;

  async function save() {
    setMsg(null); setError(null);
    const r = await fetch("/api/v1/admin/feed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(s) });
    if (r.ok) {
      setMsg("Saved. The worker picks up feed changes within ~10s.");
      const g = await fetch("/api/v1/admin/feed").then((x) => x.json()).catch(() => null);
      if (g?.log) setLog(g.log);
    } else setError((await r.json().catch(() => ({}))).error ?? "save failed");
  }

  const fmtAge = (iso: string) => { try { return new Date(iso.replace(" ", "T") + "Z").toLocaleString(); } catch { return iso; } };

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Public text feed (JSON)</h2>
        <span className={cn("pill", s.enabled && s.armed ? "pill-on" : "pill-off")}>{s.enabled && s.armed ? "armed" : s.enabled ? "enabled, disarmed" : "off"}</span>
      </div>
      <p className="text-[12px] text-ink-faint">
        Re-publishes public-channel text messages HopWatch has decoded as compact JSON to one MQTT
        broker, under <span className="mono">&lt;root&gt;/{suffix}</span>, so downstream consumers
        (Home Assistant, dashboards) get the whole de-duplicated feed without decrypting themselves.
        It publishes only <b>broadcasts on public-default-key channels</b> (never DMs, never a
        private/community channel), honours each sender&apos;s OK-to-MQTT bit, caps the text length,
        and is QoS 0 and not retained. Like the MQTT bridge, both <b>Enabled</b> and <b>Armed</b> must
        be on; disarm is the kill switch. Add the publish broker under{" "}
        <Link className="text-accent hover:underline" href="/admin/settings">ingest settings</Link> first.
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Enabled</label>
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.armed} onChange={(e) => setS({ ...s, armed: e.target.checked })} /> Armed (kill switch)</label>
        <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={s.public_only} onChange={(e) => setS({ ...s, public_only: e.target.checked })} /> Public-key channels only</label>
        <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={s.require_ok_to_mqtt} onChange={(e) => setS({ ...s, require_ok_to_mqtt: e.target.checked })} /> Require OK-to-MQTT</label>
        <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={s.all_regions} onChange={(e) => setS({ ...s, all_regions: e.target.checked })} /> All regions</label>
        <label className="flex items-center gap-2 text-[13px] text-ink-mute"><input type="checkbox" checked={s.include_reactions} onChange={(e) => setS({ ...s, include_reactions: e.target.checked })} /> Include reactions</label>
      </div>
      <p className="text-[11px] text-ink-faint">
        <b>Public-key channels only</b> (on by default) is a safety rail: the feed publishes decoded
        plaintext, so it must never carry a private/community channel. Leave it on unless you are
        pointing the feed at a broker where republishing a private channel in cleartext is acceptable.
        <b> Require OK-to-MQTT</b> skips senders who did not set the consent bit; turning it off
        republishes people who opted out, which is only appropriate on a private broker you control.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1"><span className="block stat-label">Publish to broker</span>
          <select className={`${inp} w-56`} value={s.broker_id} onChange={(e) => setS({ ...s, broker_id: e.target.value })}>
            <option value="">(select)</option>
            {brokers.map((b) => <option key={b.id} value={b.id}>{b.id} ({b.host})</option>)}
          </select>
        </label>
        <label className="space-y-1"><span className="block stat-label">Topic suffix</span>
          <input className={`${inp} w-56`} value={s.topic_suffix} onChange={(e) => setS({ ...s, topic_suffix: e.target.value })} placeholder="hopwatch/v1/text" />
        </label>
        <label className="space-y-1"><span className="block stat-label">Max text chars</span>
          <input type="number" min={1} max={512} value={String(s.max_text_chars)} onChange={(e) => setS({ ...s, max_text_chars: Number(e.target.value) })} className={`${inp} w-28`} />
        </label>
      </div>

      <div className="space-y-1">
        <span className="block stat-label">Publishes to</span>
        {!target ? <p className="text-[12px] text-ink-faint">Select a broker above.</p>
          : destTopic ? <p className="text-[12px]"><span className="mono text-ink">{destTopic}</span></p>
            : <p className="text-[12px] text-accent-strong">Broker <b>{target.id}</b> has no resolvable topic root; set its Root topic in ingest settings so the feed has somewhere to publish and a region to scope to.</p>}
        {s.all_regions
          ? <p className="text-[11px] text-ink-faint"><b>All regions</b> is on: every public-channel broadcast HopWatch decodes is republished here, including other brokers&apos; and regions&apos; chat. The broker&apos;s topic root is only the publish destination, not a filter.</p>
          : <p className="text-[11px] text-ink-faint">The broker&apos;s topic root also scopes the feed to that region: only broadcasts on <span className="mono">{(target?.root || "<root>") + "/..."}</span> (plus your own RF station node) are published, not another region&apos;s firehose. Turn on <b>All regions</b> to publish every public broadcast HopWatch decodes.</p>}
      </div>

      <div className="space-y-1">
        <span className="block stat-label">Channels to include (none checked = all eligible public-key channels)</span>
        <div className="flex flex-wrap gap-3">
          {channels.length === 0 ? <span className="text-[12px] text-ink-faint">no channels seen yet</span>
            : channels.map((c) => (
              <label key={c} className="flex items-center gap-1.5 text-[13px] text-ink-mute">
                <input type="checkbox" checked={s.channels.includes(c)} onChange={() => toggleChannel(c)} /> {c}
              </label>
            ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save feed settings</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {error && <span className="text-[12px] text-accent-strong">{error}</span>}
      </div>

      <div className="border-t border-line pt-3">
        <div className="stat-label mb-2">Recent feed publishes ({zone})</div>
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>When</th><th>Node</th><th>Channel</th><th>Packet</th><th>Topic</th></tr></thead>
            <tbody>
              {log.length === 0 && <tr><td colSpan={5} className="text-ink-faint">Nothing published yet.</td></tr>}
              {log.map((l) => (
                <tr key={l.id}>
                  <td className="text-ink-mute">{fmtAge(l.bridged_at)}</td>
                  <td className="mono">{l.from_node_id ? formatNodeId(l.from_node_id) : "-"}</td>
                  <td className="text-ink-mute">{l.channel_id ?? "-"}</td>
                  <td className="mono text-ink-faint">{l.mesh_packet_id ? (l.mesh_packet_id >>> 0) : "-"}</td>
                  <td className="mono max-w-[260px] truncate text-[11px] text-ink-faint" title={l.dest_topic ?? ""}>{l.dest_topic ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
