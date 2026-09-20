"use client";

import { useState } from "react";

// Admin controls on the node page: ignore all traffic (mute) and ignore location (hide a
// bad GPS fix from the maps). Shown only to admins.
export function NodeAdminControls({ nodeId, muted, positionIgnored, rfHeightM, rfEirpDbm }: {
  nodeId: number; muted: boolean; positionIgnored: boolean; rfHeightM: number | null; rfEirpDbm: number | null;
}) {
  const [isMuted, setMuted] = useState(muted);
  const [ignored, setIgnored] = useState(positionIgnored);
  const [height, setHeight] = useState(rfHeightM == null ? "" : String(rfHeightM));
  const [eirp, setEirp] = useState(rfEirpDbm == null ? "" : String(rfEirpDbm));
  const [rfNote, setRfNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveRf() {
    setBusy(true); setError(null); setRfNote(null);
    try {
      const r = await fetch(`/api/v1/admin/nodes/${nodeId}/rf-profile`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ height_m: height === "" ? null : Number(height), eirp_dbm: eirp === "" ? null : Number(eirp) }),
      });
      if (r.ok) setRfNote("Saved. Predicted coverage updates on the coverage map.");
      else setError((await r.json().catch(() => ({}))).error ?? "failed");
    } finally { setBusy(false); }
  }

  async function toggleMute() {
    setBusy(true); setError(null);
    try {
      const r = isMuted
        ? await fetch(`/api/v1/admin/mute-list?node_id=${nodeId}`, { method: "DELETE" })
        : await fetch(`/api/v1/admin/mute-list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node_id: nodeId, reason: "muted from node page" }) });
      if (r.ok) setMuted(!isMuted);
      else setError((await r.json().catch(() => ({}))).error ?? "failed");
    } finally { setBusy(false); }
  }

  async function toggleIgnore() {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/v1/admin/nodes/${nodeId}/ignore-position`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ignored: !ignored }),
      });
      if (r.ok) setIgnored(!ignored);
      else setError((await r.json().catch(() => ({}))).error ?? "failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="card flex flex-wrap items-center gap-3">
      <span className="eyebrow"><span className="eyebrow-bar" />Admin</span>
      <button className={`btn h-8 px-3 text-[12px] ${isMuted ? "btn-primary" : "btn-outline"}`} disabled={busy} onClick={toggleMute}>
        {isMuted ? "Unmute (ignoring all traffic)" : "Ignore all traffic (mute)"}
      </button>
      <button className={`btn h-8 px-3 text-[12px] ${ignored ? "btn-primary" : "btn-outline"}`} disabled={busy} onClick={toggleIgnore}>
        {ignored ? "Location ignored (restore)" : "Ignore location (bad GPS)"}
      </button>
      {ignored && <span className="text-[11px] text-ink-faint">hidden from all maps</span>}
      <div className="flex w-full flex-wrap items-end gap-3 border-t border-line pt-3">
        <span className="stat-label w-full">RF profile (predicted coverage)</span>
        <label className="space-y-1"><span className="block text-[11px] text-ink-faint">Antenna height (m AGL)</span>
          <input type="number" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="from altitude"
            className="h-8 w-32 rounded-md border border-line bg-raised px-2 text-[13px] text-ink" />
        </label>
        <label className="space-y-1"><span className="block text-[11px] text-ink-faint">EIRP (dBm)</span>
          <input type="number" value={eirp} onChange={(e) => setEirp(e.target.value)} placeholder="default"
            className="h-8 w-24 rounded-md border border-line bg-raised px-2 text-[13px] text-ink" />
        </label>
        <button className="btn btn-outline h-8 px-3 text-[12px]" disabled={busy} onClick={saveRf}>Save RF</button>
        <span className="text-[11px] text-ink-faint">blank = default (height from GPS altitude, EIRP from region)</span>
      </div>
      {rfNote && <span className="text-[12px] text-ok">{rfNote}</span>}
      {error && <span className="text-[12px] text-accent-strong">{error}</span>}
    </div>
  );
}
