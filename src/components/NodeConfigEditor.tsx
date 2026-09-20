"use client";

import { useState } from "react";

// Enum option lists mirror the Meshtastic firmware (extracted from @meshtastic/protobufs), so the
// dropdowns match what the app/device show. The write path maps these names back to values.
const REGIONS = ["UNSET", "US", "EU_433", "EU_868", "CN", "JP", "ANZ", "KR", "TW", "RU", "IN", "NZ_865", "TH", "LORA_24", "UA_433", "UA_868", "MY_433", "MY_919", "SG_923", "PH_433", "PH_868", "PH_915", "ANZ_433", "KZ_433", "KZ_863", "NP_865", "BR_902"];
const PRESETS = ["LONG_FAST", "LONG_SLOW", "VERY_LONG_SLOW", "MEDIUM_SLOW", "MEDIUM_FAST", "SHORT_SLOW", "SHORT_FAST", "LONG_MODERATE", "SHORT_TURBO", "LONG_TURBO"];
const ROLES = ["CLIENT", "CLIENT_MUTE", "ROUTER", "ROUTER_CLIENT", "REPEATER", "TRACKER", "SENSOR", "TAK", "CLIENT_HIDDEN", "LOST_AND_FOUND", "TAK_TRACKER", "ROUTER_LATE", "CLIENT_BASE"];
const REBROADCAST = ["ALL", "ALL_SKIP_DECODING", "LOCAL_ONLY", "KNOWN_ONLY", "NONE", "CORE_PORTNUMS_ONLY"];
const GPS_MODES = ["DISABLED", "ENABLED", "NOT_PRESENT"];

interface SnapChannel { index: number; role: string; name: string; label?: string; encrypted: boolean; uplink: boolean; downlink: boolean }
interface Snap {
  my_node_num: number | null;
  config: Record<string, Record<string, unknown>>;
  module_config: Record<string, Record<string, unknown>>;
  channels: SnapChannel[];
  nodes: { num: number; long_name?: string; short_name?: string }[];
}

const inp = "h-8 rounded-md border border-line bg-raised px-2 text-[12px] text-ink focus:border-accent focus:outline-none";
const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const b = (v: unknown) => v === true || v === "true" || v === 1;

// Edit + write the practical config set (Owner, LoRa, Device, Position, MQTT module, and each
// channel's uplink/downlink) with firmware-matching dropdowns. LoRa changes prompt a confirm;
// writes apply to the connected node only and are re-read afterward to verify. Channel writes send
// only the index + uplink/downlink toggle; the server re-reads the channel to preserve its
// name/PSK/precision (the key never reaches the browser), so channel names/keys stay untouched.
export function NodeConfigEditor({ snap, host, port, onWritten }: { snap: Snap; host: string; port: number; onWritten: (s: unknown) => void }) {
  const lora0 = snap.config.lora ?? {}, dev0 = snap.config.device ?? {}, pos0 = snap.config.position ?? {}, mqtt0 = snap.module_config.mqtt ?? {};
  const chans0 = snap.channels ?? [];
  const me = snap.nodes.find((n) => n.num === snap.my_node_num);

  const [f, setF] = useState({
    longName: me?.long_name ?? "", shortName: me?.short_name ?? "",
    region: s(lora0.region), preset: s(lora0.modem_preset), hop: s(lora0.hop_limit), txPower: s(lora0.tx_power), txEnabled: lora0.tx_enabled !== false,
    okMqtt: b(lora0.config_ok_to_mqtt), ignoreMqtt: b(lora0.ignore_mqtt),
    role: s(dev0.role), rebroadcast: s(dev0.rebroadcast_mode), nodeInfoSecs: s(dev0.node_info_broadcast_secs),
    posSecs: s(pos0.position_broadcast_secs), posSmart: b(pos0.position_broadcast_smart_enabled), fixed: b(pos0.fixed_position), gpsInterval: s(pos0.gps_update_interval), gpsMode: s(pos0.gps_mode),
    mqEnabled: b(mqtt0.enabled), mqAddress: s(mqtt0.address), mqUser: s(mqtt0.username), mqPass: "", mqRoot: s(mqtt0.root), mqEnc: b(mqtt0.encryption_enabled), mqJson: b(mqtt0.json_enabled), mqMap: b(mqtt0.map_reporting_enabled), mqProxy: b(mqtt0.proxy_to_client_enabled), mqTls: b(mqtt0.tls_enabled),
  });
  // Per-channel uplink/downlink edits, keyed by channel index.
  const [chans, setChans] = useState<Record<number, { uplink: boolean; downlink: boolean }>>(
    Object.fromEntries(chans0.map((c) => [c.index, { uplink: c.uplink, downlink: c.downlink }])),
  );
  const setChan = (idx: number, patch: Partial<{ uplink: boolean; downlink: boolean }>) =>
    setChans((prev) => ({ ...prev, [idx]: { uplink: false, downlink: false, ...prev[idx], ...patch } }));
  // Add / replace a channel (name + key + role), the way the app/CLI provision one. Default index is
  // the first free slot so a new channel does not clobber an existing one; key modes map to a PSK
  // spec the server decodes (default = the public basic key, custom = a base64 key, none = plaintext).
  const firstFreeIdx = (() => { for (let i = 1; i <= 7; i++) if (!chans0.some((c) => c.index === i)) return i; return 7; })();
  const [nc, setNc] = useState({ open: false, index: firstFreeIdx, name: "", keyMode: "default" as "default" | "custom" | "none", psk: "", role: "SECONDARY" as "SECONDARY" | "PRIMARY" | "DISABLED", uplink: false, downlink: false });
  const setNC = (patch: Partial<typeof nc>) => setNc((prev) => ({ ...prev, ...patch }));
  const [reboot, setReboot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });

  function buildOps(): { ops: unknown[]; loraChanged: boolean } {
    const ops: unknown[] = [];
    if (f.longName !== (me?.long_name ?? "") || f.shortName !== (me?.short_name ?? "")) ops.push({ kind: "owner", longName: f.longName, shortName: f.shortName });
    const loraChanged = f.region !== s(lora0.region) || f.preset !== s(lora0.modem_preset) || f.hop !== s(lora0.hop_limit) || f.txPower !== s(lora0.tx_power) || f.txEnabled !== (lora0.tx_enabled !== false) || f.okMqtt !== b(lora0.config_ok_to_mqtt) || f.ignoreMqtt !== b(lora0.ignore_mqtt);
    // use_preset is deliberately NOT sent: there is no control for it, and the write preserves
    // whatever the node reported. Hardcoding it true would switch a node running a custom modem
    // config (bandwidth/spread factor/coding rate) over to the preset, which is not what an
    // operator editing the hop limit asked for.
    if (loraChanged) ops.push({ kind: "config", section: "lora", values: { region: f.region, modem_preset: f.preset, hop_limit: Number(f.hop) || 0, tx_power: Number(f.txPower) || 0, tx_enabled: f.txEnabled, config_ok_to_mqtt: f.okMqtt, ignore_mqtt: f.ignoreMqtt } });
    if (f.role !== s(dev0.role) || f.rebroadcast !== s(dev0.rebroadcast_mode) || f.nodeInfoSecs !== s(dev0.node_info_broadcast_secs)) ops.push({ kind: "config", section: "device", values: { role: f.role, rebroadcast_mode: f.rebroadcast, node_info_broadcast_secs: Number(f.nodeInfoSecs) || 0 } });
    if (f.posSecs !== s(pos0.position_broadcast_secs) || f.posSmart !== b(pos0.position_broadcast_smart_enabled) || f.fixed !== b(pos0.fixed_position) || f.gpsInterval !== s(pos0.gps_update_interval) || f.gpsMode !== s(pos0.gps_mode))
      ops.push({ kind: "config", section: "position", values: { position_broadcast_secs: Number(f.posSecs) || 0, position_broadcast_smart_enabled: f.posSmart, fixed_position: f.fixed, gps_update_interval: Number(f.gpsInterval) || 0, gps_mode: f.gpsMode } });
    // The broker password is write-only: the snapshot reports only whether one is set, so the box
    // starts blank and is sent ONLY when the operator types a new one. Omitting the key leaves the
    // device's existing password untouched, because the write is a read-modify-write on the node's
    // own reported section. Sending the blank box would have wiped it.
    if (f.mqEnabled !== b(mqtt0.enabled) || f.mqAddress !== s(mqtt0.address) || f.mqUser !== s(mqtt0.username) || f.mqPass !== "" || f.mqRoot !== s(mqtt0.root) || f.mqEnc !== b(mqtt0.encryption_enabled) || f.mqJson !== b(mqtt0.json_enabled) || f.mqMap !== b(mqtt0.map_reporting_enabled) || f.mqProxy !== b(mqtt0.proxy_to_client_enabled) || f.mqTls !== b(mqtt0.tls_enabled))
      ops.push({ kind: "moduleConfig", section: "mqtt", values: { enabled: f.mqEnabled, address: f.mqAddress, username: f.mqUser, ...(f.mqPass ? { password: f.mqPass } : {}), root: f.mqRoot, encryption_enabled: f.mqEnc, json_enabled: f.mqJson, map_reporting_enabled: f.mqMap, proxy_to_client_enabled: f.mqProxy, tls_enabled: f.mqTls } });
    // One channel op per channel whose uplink/downlink toggle changed (server preserves name/PSK).
    for (const c of chans0) {
      const cur = chans[c.index] ?? { uplink: c.uplink, downlink: c.downlink };
      if (cur.uplink !== c.uplink || cur.downlink !== c.downlink)
        ops.push({ kind: "channel", index: c.index, uplink_enabled: cur.uplink, downlink_enabled: cur.downlink });
    }
    // Add / replace a channel when the form is open and a name is set. "default" = the public basic
    // key, "none" = plaintext, "custom" = the base64 key the operator typed.
    if (nc.open && nc.name.trim()) {
      const psk = nc.keyMode === "default" ? "default" : nc.keyMode === "none" ? "none" : nc.psk.trim();
      ops.push({ kind: "channelSet", index: nc.index, name: nc.name.trim(), psk, role: nc.role, uplink_enabled: nc.uplink, downlink_enabled: nc.downlink });
    }
    return { ops, loraChanged };
  }

  async function write() {
    setMsg(null); setErr(null);
    const { ops, loraChanged } = buildOps();
    if (ops.length === 0) { setErr("no changes"); return; }
    if (loraChanged && !confirm("LoRa changes (region/preset/tx power) can take the node off the mesh or off MQTT. Write anyway?")) return;
    setBusy(true);
    try {
      const r = await fetch("/api/v1/admin/node/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host, port, ops, reboot }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setMsg("Written. Node re-read to confirm."); if (d.snapshot) onWritten(d.snapshot); }
      else setErr(d.error ?? "write failed");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function rebootNode() {
    setMsg(null); setErr(null);
    if (!confirm("Reboot the connected station node now? It will drop off the mesh for ~15-30s while it restarts.")) return;
    setBusy(true);
    try {
      const r = await fetch("/api/v1/admin/node/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host, port, ops: [], reboot: true }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setMsg("Reboot sent. The node is restarting; RF will reconnect shortly."); if (d.snapshot) onWritten(d.snapshot); }
      else setErr(d.error ?? "reboot failed");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const field = (label: string, node: React.ReactNode) => <label className="space-y-1"><span className="block stat-label">{label}</span>{node}</label>;
  const sel = (val: string, opts: string[], on: (v: string) => void, w = "w-40") => (
    <select value={val} onChange={(e) => on(e.target.value)} className={`${inp} ${w}`}>{!opts.includes(val) && <option value={val}>{val || "(unset)"}</option>}{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select>
  );

  return (
    <details className="mt-2 border-t border-line pt-3">
      <summary className="cursor-pointer stat-label">Edit &amp; write config (Owner, LoRa, Device, Position, MQTT, Channels)</summary>
      <div className="mt-3 space-y-4 text-[12px]">
        <div className="space-y-1"><div className="stat-label">Owner</div><div className="flex flex-wrap items-end gap-3">
          {field("Long name", <input className={`${inp} w-48`} value={f.longName} onChange={(e) => set({ longName: e.target.value })} />)}
          {field("Short name", <input className={`${inp} w-24`} maxLength={4} value={f.shortName} onChange={(e) => set({ shortName: e.target.value })} />)}
        </div></div>

        <div className="space-y-1"><div className="stat-label">LoRa</div><div className="flex flex-wrap items-end gap-3">
          {field("Region", sel(f.region, REGIONS, (v) => set({ region: v }), "w-28"))}
          {field("Modem preset", sel(f.preset, PRESETS, (v) => set({ preset: v })))}
          {field("Hop limit", <input type="number" className={`${inp} w-20`} value={f.hop} onChange={(e) => set({ hop: e.target.value })} />)}
          {field("TX power", <input type="number" className={`${inp} w-20`} value={f.txPower} onChange={(e) => set({ txPower: e.target.value })} />)}
          <label className="flex items-center gap-2 text-ink-mute"><input type="checkbox" checked={f.txEnabled} onChange={(e) => set({ txEnabled: e.target.checked })} /> TX enabled</label>
          <label className="flex items-center gap-2 text-ink-mute" title="Sets the ok_to_mqtt bit on this node's outgoing packets so gateways may uplink them to MQTT"><input type="checkbox" checked={f.okMqtt} onChange={(e) => set({ okMqtt: e.target.checked })} /> OK to MQTT</label>
          <label className="flex items-center gap-2 text-ink-mute" title="Node ignores MQTT entirely (no uplink/downlink)"><input type="checkbox" checked={f.ignoreMqtt} onChange={(e) => set({ ignoreMqtt: e.target.checked })} /> Ignore MQTT</label>
        </div></div>

        <div className="space-y-1"><div className="stat-label">Device</div><div className="flex flex-wrap items-end gap-3">
          {field("Role", sel(f.role, ROLES, (v) => set({ role: v })))}
          {field("Rebroadcast", sel(f.rebroadcast, REBROADCAST, (v) => set({ rebroadcast: v }), "w-48"))}
          {field("NodeInfo interval (s)", <input type="number" className={`${inp} w-28`} value={f.nodeInfoSecs} onChange={(e) => set({ nodeInfoSecs: e.target.value })} />)}
        </div></div>

        <div className="space-y-1"><div className="stat-label">Position</div><div className="flex flex-wrap items-end gap-3">
          {field("Broadcast (s)", <input type="number" className={`${inp} w-24`} value={f.posSecs} onChange={(e) => set({ posSecs: e.target.value })} />)}
          {field("GPS update (s)", <input type="number" className={`${inp} w-24`} value={f.gpsInterval} onChange={(e) => set({ gpsInterval: e.target.value })} />)}
          {field("GPS mode", sel(f.gpsMode, GPS_MODES, (v) => set({ gpsMode: v }), "w-36"))}
          <label className="flex items-center gap-2 text-ink-mute"><input type="checkbox" checked={f.posSmart} onChange={(e) => set({ posSmart: e.target.checked })} /> smart</label>
          <label className="flex items-center gap-2 text-ink-mute"><input type="checkbox" checked={f.fixed} onChange={(e) => set({ fixed: e.target.checked })} /> fixed</label>
        </div></div>

        <div className="space-y-1"><div className="stat-label">MQTT module</div><div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-ink-mute"><input type="checkbox" checked={f.mqEnabled} onChange={(e) => set({ mqEnabled: e.target.checked })} /> enabled</label>
          {field("Address", <input className={`${inp} w-52`} value={f.mqAddress} onChange={(e) => set({ mqAddress: e.target.value })} />)}
          {field("Username", <input className={`${inp} w-32`} value={f.mqUser} onChange={(e) => set({ mqUser: e.target.value })} />)}
          {field(mqtt0.has_password ? "Password (set)" : "Password", <input className={`${inp} w-32`} type="password" placeholder={mqtt0.has_password ? "unchanged" : ""} value={f.mqPass} onChange={(e) => set({ mqPass: e.target.value })} />)}
          {field("Root topic", <input className={`${inp} w-40`} value={f.mqRoot} onChange={(e) => set({ mqRoot: e.target.value })} />)}
          <label className="flex items-center gap-2 text-ink-mute"><input type="checkbox" checked={f.mqEnc} onChange={(e) => set({ mqEnc: e.target.checked })} /> encryption</label>
          <label className="flex items-center gap-2 text-ink-mute"><input type="checkbox" checked={f.mqJson} onChange={(e) => set({ mqJson: e.target.checked })} /> JSON</label>
          <label className="flex items-center gap-2 text-ink-mute"><input type="checkbox" checked={f.mqMap} onChange={(e) => set({ mqMap: e.target.checked })} /> map reporting</label>
          <label className="flex items-center gap-2 text-ink-mute" title="Route MQTT through a connected client app instead of the node's own network link"><input type="checkbox" checked={f.mqProxy} onChange={(e) => set({ mqProxy: e.target.checked })} /> proxy to client</label>
          <label className="flex items-center gap-2 text-ink-mute"><input type="checkbox" checked={f.mqTls} onChange={(e) => set({ mqTls: e.target.checked })} /> TLS</label>
        </div></div>

        {chans0.length > 0 && (
          <div className="space-y-1"><div className="stat-label">Channels (uplink / downlink to MQTT)</div>
            <table className="data text-[12px]">
              <thead><tr><th>#</th><th>Name</th><th>Role</th><th className="text-center">Uplink</th><th className="text-center">Downlink</th></tr></thead>
              <tbody>
                {chans0.map((c) => {
                  const cur = chans[c.index] ?? { uplink: c.uplink, downlink: c.downlink };
                  return (
                    <tr key={c.index}>
                      <td className="tabular-nums text-ink-faint">{c.index}</td>
                      <td className="mono">{c.label ?? c.name}{c.encrypted && <span className="ml-1 text-ink-faint" title="encrypted">🔒</span>}</td>
                      <td className="text-ink-faint">{c.role}</td>
                      <td className="text-center"><input type="checkbox" checked={cur.uplink} onChange={(e) => setChan(c.index, { uplink: e.target.checked })} /></td>
                      <td className="text-center"><input type="checkbox" checked={cur.downlink} onChange={(e) => setChan(c.index, { downlink: e.target.checked })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-[11px] text-ink-faint">Uplink sends this channel&apos;s traffic to MQTT; downlink rebroadcasts MQTT traffic back onto RF (this is the faithful rebroadcast). Name and key are preserved on write.</p>
          </div>
        )}

        <div className="space-y-1">
          <label className="flex items-center gap-2 stat-label"><input type="checkbox" checked={nc.open} onChange={(e) => setNC({ open: e.target.checked })} /> Add / replace a channel</label>
          {nc.open && (
            <div className="space-y-2 rounded-md border border-line p-2">
              <div className="flex flex-wrap items-end gap-3">
                {field("Slot", sel(String(nc.index), ["1", "2", "3", "4", "5", "6", "7"], (v) => setNC({ index: Number(v) }), "w-16"))}
                {field("Name", <input className={`${inp} w-40`} maxLength={11} value={nc.name} onChange={(e) => setNC({ name: e.target.value })} placeholder="Testing" />)}
                {field("Encryption", sel(nc.keyMode, ["default", "custom", "none"], (v) => setNC({ keyMode: v as typeof nc.keyMode }), "w-32"))}
                {nc.keyMode === "custom" && field("Key (base64)", <input className={`${inp} w-56`} value={nc.psk} onChange={(e) => setNC({ psk: e.target.value })} placeholder="16 or 32 byte base64" />)}
                {field("Role", sel(nc.role, ["SECONDARY", "PRIMARY", "DISABLED"], (v) => setNC({ role: v as typeof nc.role }), "w-32"))}
                <label className="flex items-center gap-2 text-ink-mute"><input type="checkbox" checked={nc.uplink} onChange={(e) => setNC({ uplink: e.target.checked })} /> uplink</label>
                <label className="flex items-center gap-2 text-ink-mute"><input type="checkbox" checked={nc.downlink} onChange={(e) => setNC({ downlink: e.target.checked })} /> downlink</label>
              </div>
              <p className="text-[11px] text-ink-faint">Provisions a channel on this node so it can decode, transmit and ack there. <b>default</b> = the public basic key (the same one shared on the site); <b>none</b> = plaintext; <b>custom</b> = your own base64 key. Writing to a slot that already has a channel replaces its name, key and role. Include the changes with &quot;Write changes to node&quot; below.</p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-line pt-2">
          <button className="btn btn-primary h-8 px-3 text-[12px]" disabled={busy} onClick={write}>{busy ? "Writing..." : "Write changes to node"}</button>
          <label className="flex items-center gap-2 text-ink-mute"><input type="checkbox" checked={reboot} onChange={(e) => setReboot(e.target.checked)} /> reboot after</label>
          <button className="btn btn-outline h-8 px-3 text-[12px]" disabled={busy} onClick={rebootNode} title="Send a reboot AdminMessage to the node now (no config change)">{busy ? "..." : "Reboot node"}</button>
          {msg && <span className="text-ok">{msg}</span>}
          {err && <span className="text-accent-strong">{err}</span>}
        </div>
        <p className="text-[11px] text-ink-faint">Writes apply to the connected node only (not an RF transmit). Existing channel keys are preserved by the server and never shown here; a channel you add here sends the key you choose to the node.</p>
      </div>
    </details>
  );
}
