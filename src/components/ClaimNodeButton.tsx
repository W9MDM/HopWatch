"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Status {
  signed_in: boolean;
  owned_node_id: number | null;
  owner_label: string | null;
  mine: boolean;
  can_claim: boolean;
  claimed?: boolean;
}

const inp = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";
const j = (r: Response) => r.json().catch(() => ({}));
const send = async (url: string, method: string, body?: unknown) => {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, error: r.ok ? undefined : (await j(r)).error ?? `${method} failed` };
};
const fmtDate = (s: string | null) => (s ? s.replace("T", " ").slice(0, 16).replace(/\.\d+$/, "") : "-");

// "Claim this node" control for the observed node detail page. Any signed-in (Discord) user
// can claim an unclaimed node; the owner or an admin can release it. Hidden entirely for
// anonymous viewers.
export function ClaimNodeButton({ numId, name, lat, lng, role }: { numId: number; name: string; lat: number | null; lng: number | null; role: string | null }) {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    const r = await fetch(`/api/v1/owned/claim?num_id=${numId}`);
    if (r.ok) setSt(await r.json());
    else setSt({ signed_in: false, owned_node_id: null, owner_label: null, mine: false, can_claim: false });
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [numId]);

  if (!st || !st.signed_in) return null; // anonymous: nothing to show

  const claimed = !!(st.owned_node_id && st.owner_label);

  async function claim() {
    setBusy(true); setErr(null);
    const r = await fetch("/api/v1/owned/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ num_id: numId, name, lat, lng, role }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(d.error ?? "claim failed"); return; }
    await load();
  }

  async function release() {
    if (!confirm("Release ownership of this node?")) return;
    setBusy(true); setErr(null);
    const r = await fetch(`/api/v1/owned/claim?num_id=${numId}`, { method: "DELETE" });
    setBusy(false);
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error ?? "release failed"); return; }
    await load();
  }

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center gap-3">
        <span className="eyebrow"><span className="eyebrow-bar" />Ownership</span>
        {st.mine ? (
          <>
            <span className="text-[13px] text-ok">You own this node.</span>
            <Link className="btn btn-outline h-8 px-3 text-[13px]" href="/owned-nodes">Registry</Link>
            <button className="btn btn-outline h-8 px-3 text-[13px]" disabled={busy} onClick={release}>Release</button>
          </>
        ) : claimed ? (
          <span className="text-[13px] text-ink-mute">Owned by <span className="text-ink">{st.owner_label}</span>{st.can_claim ? " (admin can reassign)" : ""}
            {st.can_claim && <button className="btn btn-outline ml-3 h-8 px-3 text-[13px]" disabled={busy} onClick={claim}>Claim for me</button>}
          </span>
        ) : (
          <>
            <span className="text-[13px] text-ink-faint">This node is unclaimed.</span>
            <button className="btn btn-primary h-8 px-3 text-[13px]" disabled={busy} onClick={claim}>{busy ? "Claiming..." : "Claim this node"}</button>
          </>
        )}
        {err && <span className="text-[12px] text-accent-strong">{err}</span>}
      </div>
      {st.mine && st.owned_node_id && <OwnerNodePanel id={st.owned_node_id} />}
    </div>
  );
}

interface UserOpt { id: number; username: string }
interface GroupOpt { id: number; name: string }
interface Maint { id: number; visit_date: string; notes: string | null; username: string | null }
interface Iss { id: number; issue_type: string; description: string | null; status: string; reported_at: string; reporter: string | null }
interface Shr { id: number; user_id: number | null; group_id: number | null; permission_level: string; label: string }

// Owner-only management shown inline on the observed node page for a node you have claimed:
// maintenance log, issue tracking, and sharing. Backed by the same /api/v1/owned endpoints.
function OwnerNodePanel({ id }: { id: number }) {
  const [maint, setMaint] = useState<Maint[]>([]);
  const [issues, setIssues] = useState<Iss[]>([]);
  const [shares, setShares] = useState<Shr[]>([]);
  const [users, setUsers] = useState<UserOpt[]>([]);
  const [groups, setGroups] = useState<GroupOpt[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const base = `/api/v1/owned/nodes/${id}`;

  const reload = useCallback(async () => {
    const [mi, is, sh, meta] = await Promise.all([
      fetch(`${base}/maintenance`).then(j), fetch(`${base}/issues`).then(j), fetch(`${base}/shares`).then(j), fetch("/api/v1/owned/meta").then(j),
    ]);
    setMaint(mi.maintenance ?? []); setIssues(is.issues ?? []); setShares(sh.shares ?? []);
    setUsers(meta.users ?? []); setGroups(meta.groups ?? []);
  }, [base]);
  useEffect(() => { reload(); }, [reload]);

  const act = async (p: Promise<{ ok: boolean; error?: string }>) => { const r = await p; if (!r.ok) setErr(r.error!); else { setErr(null); await reload(); } };

  return (
    <div className="card space-y-4">
      <h2 className="eyebrow"><span className="eyebrow-bar" />Your node: maintenance, issues &amp; sharing</h2>
      {err && <div className="rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[12px] text-accent-strong">{err}</div>}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Issues */}
        <div className="space-y-2">
          <div className="stat-label">Issues</div>
          {issues.map((it) => (
            <div key={it.id} className="rounded-md border border-line p-2 text-[12px]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">{it.issue_type}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${it.status === "open" ? "bg-accent/20 text-accent-strong" : it.status === "in_progress" ? "bg-raised text-ink" : "text-ink-faint"}`}>{it.status}</span>
              </div>
              {it.description && <p className="mt-1 text-ink-mute">{it.description}</p>}
              <div className="mt-1 text-[10px] text-ink-faint">{it.reporter ?? "?"} · {fmtDate(it.reported_at)}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {["open", "in_progress", "resolved", "closed"].filter((s) => s !== it.status).map((s) => (
                  <button key={s} className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-mute hover:text-ink" onClick={() => act(send(`${base}/issues`, "PATCH", { issue_id: it.id, status: s }))}>{s}</button>
                ))}
                <button className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-mute hover:text-accent-strong" onClick={() => act(send(`${base}/issues?issue_id=${it.id}`, "DELETE"))}>del</button>
              </div>
            </div>
          ))}
          {issues.length === 0 && <p className="text-[12px] text-ink-faint">No issues.</p>}
          <MiniIssueAdd onAdd={(t, d) => act(send(`${base}/issues`, "POST", { issue_type: t, description: d }))} />
        </div>
        {/* Maintenance */}
        <div className="space-y-2">
          <div className="stat-label">Maintenance log</div>
          {maint.map((m) => (
            <div key={m.id} className="rounded-md border border-line p-2 text-[12px]">
              <div className="flex items-center justify-between"><span className="text-ink">{fmtDate(m.visit_date)}</span><button className="text-[10px] text-ink-faint hover:text-accent-strong" onClick={() => act(send(`${base}/maintenance?entry_id=${m.id}`, "DELETE"))}>del</button></div>
              {m.notes && <p className="mt-1 text-ink-mute">{m.notes}</p>}
              <div className="mt-1 text-[10px] text-ink-faint">{m.username ?? "?"}</div>
            </div>
          ))}
          {maint.length === 0 && <p className="text-[12px] text-ink-faint">No visits logged.</p>}
          <MiniMaintAdd onAdd={(date, notes) => act(send(`${base}/maintenance`, "POST", { visit_date: date, notes }))} />
        </div>
        {/* Sharing */}
        <div className="space-y-2">
          <div className="stat-label">Sharing</div>
          {shares.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-md border border-line p-2 text-[12px]">
              <span className="text-ink">{s.label} <span className="text-ink-faint">({s.group_id ? "group" : "user"}, {s.permission_level})</span></span>
              <button className="text-[10px] text-ink-faint hover:text-accent-strong" onClick={() => act(send(`${base}/shares?share_id=${s.id}`, "DELETE"))}>remove</button>
            </div>
          ))}
          {shares.length === 0 && <p className="text-[12px] text-ink-faint">Not shared.</p>}
          <MiniShareAdd users={users} groups={groups} onAdd={(body) => act(send(`${base}/shares`, "POST", body))} />
        </div>
      </div>
    </div>
  );
}

function MiniIssueAdd({ onAdd }: { onAdd: (t: string, d: string) => void }) {
  const [open, setOpen] = useState(false); const [t, setT] = useState(""); const [d, setD] = useState("");
  if (!open) return <button className="text-[12px] text-accent hover:underline" onClick={() => setOpen(true)}>+ Report issue</button>;
  return (
    <div className="space-y-1">
      <input value={t} onChange={(e) => setT(e.target.value)} placeholder="Issue type" className={`${inp} w-full`} />
      <textarea value={d} onChange={(e) => setD(e.target.value)} placeholder="Description" className={`${inp} h-14 w-full py-1`} />
      <div className="flex gap-2"><button className="btn btn-primary h-7 px-2 text-[12px]" disabled={!t.trim()} onClick={() => { onAdd(t, d); setT(""); setD(""); setOpen(false); }}>Add</button><button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>
  );
}
function MiniMaintAdd({ onAdd }: { onAdd: (date: string, notes: string) => void }) {
  const [open, setOpen] = useState(false); const [date, setDate] = useState(""); const [notes, setNotes] = useState("");
  if (!open) return <button className="text-[12px] text-accent hover:underline" onClick={() => setOpen(true)}>+ Log visit</button>;
  return (
    <div className="space-y-1">
      <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} className={`${inp} w-full`} />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was done" className={`${inp} h-14 w-full py-1`} />
      <div className="flex gap-2"><button className="btn btn-primary h-7 px-2 text-[12px]" onClick={() => { onAdd(date, notes); setDate(""); setNotes(""); setOpen(false); }}>Add</button><button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>
  );
}
function MiniShareAdd({ users, groups, onAdd }: { users: UserOpt[]; groups: GroupOpt[]; onAdd: (body: Record<string, unknown>) => void }) {
  const [kind, setKind] = useState<"user" | "group">("user"); const [target, setTarget] = useState(""); const [level, setLevel] = useState<"view" | "edit">("view");
  return (
    <div className="flex flex-wrap items-center gap-1">
      <select value={kind} onChange={(e) => { setKind(e.target.value as "user" | "group"); setTarget(""); }} className={`${inp} h-8`}><option value="user">User</option><option value="group">Group</option></select>
      <select value={target} onChange={(e) => setTarget(e.target.value)} className={`${inp} h-8 flex-1`}>
        <option value="">select...</option>
        {(kind === "user" ? users.map((u) => ({ id: u.id, name: u.username })) : groups.map((g) => ({ id: g.id, name: g.name }))).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      <select value={level} onChange={(e) => setLevel(e.target.value as "view" | "edit")} className={`${inp} h-8`}><option value="view">view</option><option value="edit">edit</option></select>
      <button className="btn btn-primary h-8 px-2 text-[12px]" disabled={!target} onClick={() => onAdd({ [kind === "user" ? "user_id" : "group_id"]: Number(target), permission_level: level })}>Share</button>
    </div>
  );
}
