"use client";

import { useRef, useState } from "react";

interface Counts { users: number; usersCreated: number; groups: number; members: number; nodes: number; perms: number; maint: number; issues: number }
interface Result { counts: Counts; warnings: string[]; dryRun: boolean }

const inp = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

// Admin panel to import meshadmin data into the owned-node tables. Upload a mysqldump .sql
// file, or connect to a live MySQL. Dry-run previews counts without writing.
export function ImportMeshadminPanel({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"sql" | "live">("sql");
  const [meshTable, setMeshTable] = useState("nodes");
  const [dryRun, setDryRun] = useState(true);
  const [live, setLive] = useState({ host: "localhost", port: "3306", user: "root", password: "", admin_db: "mesh_network", mesh_db: "meshadmin" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run() {
    setBusy(true); setError(null); setResult(null);
    try {
      let r: Response;
      if (mode === "sql") {
        const file = fileRef.current?.files?.[0];
        if (!file) { setError("choose a .sql file first"); setBusy(false); return; }
        const fd = new FormData();
        fd.append("file", file); fd.append("mesh_table", meshTable); fd.append("dry_run", String(dryRun));
        r = await fetch("/api/v1/admin/owned-import", { method: "POST", body: fd });
      } else {
        r = await fetch("/api/v1/admin/owned-import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "live", ...live, port: Number(live.port), mesh_table: meshTable, dry_run: dryRun }) });
      }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? "import failed"); }
      else { setResult(d as Result); if (!d.dryRun) onDone(); }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const C = result?.counts;
  return (
    <section className="card space-y-4">
      <h2 className="eyebrow"><span className="eyebrow-bar" />Import from meshadmin</h2>
      <p className="text-[12px] text-ink-faint">
        Imports owned nodes, groups, sharing, maintenance, and issues from the meshadmin app.
        Owners are matched to HopWatch accounts (by Discord id / username); unmatched Discord
        users get a linked member account. Re-runnable: nodes match by node id, so a second run
        updates rather than duplicating. Run a dry-run first to preview.
      </p>

      <div className="flex items-center gap-2">
        <button className={`btn h-8 px-3 text-[13px] ${mode === "sql" ? "btn-primary" : "btn-outline"}`} onClick={() => setMode("sql")}>Upload .sql dump</button>
        <button className={`btn h-8 px-3 text-[13px] ${mode === "live" ? "btn-primary" : "btn-outline"}`} onClick={() => setMode("live")}>Live database</button>
      </div>

      {mode === "sql" ? (
        <div className="space-y-2">
          <input ref={fileRef} type="file" accept=".sql,text/plain" className="block text-[13px] text-ink file:mr-3 file:rounded-md file:border file:border-line file:bg-raised file:px-3 file:py-1.5 file:text-[13px] file:text-ink" />
          <p className="text-[11px] text-ink-faint">A mysqldump of the meshadmin tables. Parsed in-process (no temporary database, no extra MySQL privileges needed).</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="space-y-1"><span className="block stat-label">Host</span><input value={live.host} onChange={(e) => setLive({ ...live, host: e.target.value })} className={`${inp} w-full`} /></label>
          <label className="space-y-1"><span className="block stat-label">Port</span><input value={live.port} onChange={(e) => setLive({ ...live, port: e.target.value })} className={`${inp} w-full`} /></label>
          <label className="space-y-1"><span className="block stat-label">User</span><input value={live.user} onChange={(e) => setLive({ ...live, user: e.target.value })} className={`${inp} w-full`} /></label>
          <label className="space-y-1"><span className="block stat-label">Password</span><input type="password" value={live.password} onChange={(e) => setLive({ ...live, password: e.target.value })} className={`${inp} w-full`} /></label>
          <label className="space-y-1"><span className="block stat-label">Admin DB</span><input value={live.admin_db} onChange={(e) => setLive({ ...live, admin_db: e.target.value })} className={`${inp} w-full`} /></label>
          <label className="space-y-1"><span className="block stat-label">Mesh DB</span><input value={live.mesh_db} onChange={(e) => setLive({ ...live, mesh_db: e.target.value })} className={`${inp} w-full`} /></label>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <label className="space-y-1"><span className="block stat-label">Nodes table</span><input value={meshTable} onChange={(e) => setMeshTable(e.target.value)} className={`${inp} w-40`} /></label>
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Dry-run (preview, no writes)</label>
        <button className="btn btn-primary h-9 px-4 text-[13px]" disabled={busy} onClick={run}>{busy ? "Importing..." : dryRun ? "Preview import" : "Run import"}</button>
      </div>

      {error && <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[13px] text-accent-strong">{error}</div>}

      {C && (
        <div className="space-y-2">
          <div className={`text-[13px] ${result!.dryRun ? "text-ink-mute" : "text-ok"}`}>{result!.dryRun ? "Dry-run preview (nothing written):" : "Import complete."}</div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-mute">
            <span>Nodes <span className="text-ink">{C.nodes}</span></span>
            <span>Users <span className="text-ink">{C.users}</span> ({C.usersCreated} new)</span>
            <span>Groups <span className="text-ink">{C.groups}</span></span>
            <span>Members <span className="text-ink">{C.members}</span></span>
            <span>Shares <span className="text-ink">{C.perms}</span></span>
            <span>Maintenance <span className="text-ink">{C.maint}</span></span>
            <span>Issues <span className="text-ink">{C.issues}</span></span>
          </div>
          {result!.warnings.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-accent-strong">{result!.warnings.length} warning(s)</summary>
              <ul className="mt-1 space-y-0.5 text-ink-faint">{result!.warnings.slice(0, 50).map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
