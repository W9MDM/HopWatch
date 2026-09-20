"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

export interface AdminScannerSettings {
  enabled: boolean; interval_hours: number; max_per_run: number; max_active_age_hours: number; reconfirm_hours: number;
}
interface Row {
  node_id: number; node_hex: string; long_name: string | null; short_name: string | null;
  first_ok_at: string | null; last_ok_at: string | null; last_scan_at: string | null;
  ok_count: number; firmware_version: string | null; hw_model: string | null; role: string | null;
}

const inputCls = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";
const fmt = (s: string | null) => (s ? s.slice(0, 16).replace("T", " ") : "-");

// Remote-admin scanner: settings + the PERSISTENT record of administrable nodes. Unlike a live
// "recently scanned" view, rows stay until forgotten, so nodes you can admin are never lost.
export function RemoteAdminManager({ initialSettings, initialRows }: { initialSettings: AdminScannerSettings; initialRows: Row[] }) {
  const [s, setS] = useState<AdminScannerSettings>(initialSettings);
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [scanNode, setScanNode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/v1/admin/remote-admin", { cache: "no-store" });
    if (r.ok) { const j = await r.json(); setRows(j.rows ?? []); }
  }, []);

  useEffect(() => {
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function post(body: Record<string, unknown>, ok: string) {
    setMsg(null); setErr(null);
    const r = await fetch("/api/v1/admin/remote-admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setMsg(j.note ?? ok); await refresh(); } else setErr(j.error ?? "failed");
  }

  const adminable = rows.filter((r) => r.last_ok_at);
  const probedOnly = rows.filter((r) => !r.last_ok_at);

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="eyebrow"><span className="eyebrow-bar" />Remote admin scanner</h2>
        <p className="mt-1 text-[13px] text-ink-faint">
          Probes mesh nodes with a DeviceMetadata admin request to discover which ones this station can remotely administer.
          Successful nodes are kept permanently below (they are not lost when a scan cycles). Requires TX enabled + armed +
          dry-run off and a station node; a node only answers if this station is an authorized admin on it.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Auto-scan enabled</label>
        <label className="space-y-1"><span className="block stat-label">Re-probe interval (h)</span><input type="number" value={String(s.interval_hours)} onChange={(e) => setS({ ...s, interval_hours: Number(e.target.value) })} className={`${inputCls} w-28`} /></label>
        <label className="space-y-1"><span className="block stat-label">Max per run</span><input type="number" value={String(s.max_per_run)} onChange={(e) => setS({ ...s, max_per_run: Number(e.target.value) })} className={`${inputCls} w-24`} /></label>
        <label className="space-y-1"><span className="block stat-label">Only nodes seen within (h)</span><input type="number" value={String(s.max_active_age_hours)} onChange={(e) => setS({ ...s, max_active_age_hours: Number(e.target.value) })} className={`${inputCls} w-28`} /></label>
        <label className="space-y-1"><span className="block stat-label">Re-verify confirmed every (h, 0 = never)</span><input type="number" min={0} value={String(s.reconfirm_hours)} onChange={(e) => setS({ ...s, reconfirm_hours: Number(e.target.value) })} className={`${inputCls} w-40`} /></label>
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={() => post({ op: "settings", ...s }, "Saved.")}>Save</button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1"><span className="block stat-label">Probe a node now</span>
          <input value={scanNode} onChange={(e) => setScanNode(e.target.value)} placeholder="!f661aa40 or 4133595712" className={`${inputCls} w-56`} />
        </label>
        <button className="btn btn-outline h-9 px-3 text-[13px]" disabled={!scanNode.trim()} onClick={() => post({ op: "scan", node: scanNode.trim() }, "Probe queued.")}>Probe</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {err && <span className="text-[12px] text-accent-strong">{err}</span>}
      </div>

      <div>
        <div className="stat-label mb-1">Administrable nodes ({adminable.length})</div>
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>Node</th><th>Name</th><th>Firmware</th><th>HW</th><th>Role</th><th>First OK</th><th>Last OK</th><th className="text-right">OKs</th><th></th></tr></thead>
            <tbody>
              {adminable.length === 0 && <tr><td colSpan={9} className="text-ink-faint">None recorded yet. Enable auto-scan or probe a node above.</td></tr>}
              {adminable.map((r) => (
                <tr key={r.node_id}>
                  <td className="mono"><Link className="callsign" href={`/nodes/${r.node_id}`}>{r.node_hex}</Link></td>
                  <td>{r.long_name ?? r.short_name ?? "-"}</td>
                  <td className="text-ink-faint">{r.firmware_version ?? "-"}</td>
                  <td className="text-ink-faint">{r.hw_model ?? "-"}</td>
                  <td className="text-ink-faint">{r.role ?? "-"}</td>
                  <td className="text-ink-faint whitespace-nowrap">{fmt(r.first_ok_at)}</td>
                  <td className="text-ink-faint whitespace-nowrap">{fmt(r.last_ok_at)}</td>
                  <td className="text-right tabular-nums">{r.ok_count}</td>
                  <td className="text-right"><button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => post({ op: "forget", node: r.node_hex }, "Forgotten.")}>Forget</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {probedOnly.length > 0 && (
        <details>
          <summary className="cursor-pointer stat-label">Probed, no admin access ({probedOnly.length})</summary>
          <div className="mt-1 overflow-x-auto">
            <table className="data">
              <thead><tr><th>Node</th><th>Name</th><th>Last probed</th></tr></thead>
              <tbody>
                {probedOnly.map((r) => (
                  <tr key={r.node_id}><td className="mono">{r.node_hex}</td><td className="text-ink-faint">{r.long_name ?? r.short_name ?? "-"}</td><td className="text-ink-faint whitespace-nowrap">{fmt(r.last_scan_at)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
