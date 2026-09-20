"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { OwnedNodesMap } from "./OwnedNodesMap.tsx";
import { ImportMeshadminPanel } from "./ImportMeshadminPanel.tsx";

interface Actor { id: number; username: string; admin: boolean }
interface OwnedNode {
  id: number; name: string; node_id: string | null; num_id: number | null;
  owner: string | null; owner_type: "user" | "group"; owner_user_id: number | null; owner_group_id: number | null;
  model: string | null; elevation: string | null; frequency: string; mqtt_topic: string | null;
  mqtt_connected: number; online: number; role: string; lat: number | null; lng: number | null;
  planned_site: number; created_at: string; owner_label: string | null; open_issues: number;
  observed_name: string | null; observed_last_seen: string | null; can_edit: boolean;
}
interface UserOpt { id: number; username: string; discord_username: string | null }
interface Group { id: number; name: string; description: string | null; created_by: number | null; created_at: string; member_count: number; creator: string | null }
interface Share { id: number; user_id: number | null; group_id: number | null; permission_level: "view" | "edit"; label: string }
interface Maintenance { id: number; user_id: number | null; visit_date: string; notes: string | null; username: string | null }
interface Issue { id: number; issue_type: string; description: string | null; status: string; reported_at: string; resolved_at: string | null; reporter: string | null }

const inp = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";
const j = (r: Response) => r.json().catch(() => ({}));

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (r.ok) return { ok: true };
  return { ok: false, error: (await j(r)).error ?? `${method} failed` };
}

function fmtDate(s: string | null): string {
  if (!s) return "-";
  return s.replace("T", " ").slice(0, 16).replace(/\.\d+$/, "");
}

const EMPTY = { name: "", node_id: "", role: "Client", model: "", elevation: "", frequency: "915 MHz", mqtt_topic: "", lat: "", lng: "", mqtt_connected: false, online: false, planned_site: false, owner_type: "user" as "user" | "group", owner_user_id: "", owner_group_id: "" };

export function OwnedNodesManager({ tile }: { tile: { url: string; attribution: string; darkUrl?: string; darkAttribution?: string } }) {
  const [nodes, setNodes] = useState<OwnedNode[]>([]);
  const [actor, setActor] = useState<Actor | null>(null);
  const [users, setUsers] = useState<UserOpt[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<null | (typeof EMPTY & { id?: number })>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [tab, setTab] = useState<"nodes" | "map" | "groups" | "import">("nodes");
  const [q, setQ] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [sortKey, setSortKey] = useState<"name" | "node_id" | "owner" | "role" | "status" | "issues">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const loadNodes = useCallback(async () => {
    const r = await fetch("/api/v1/owned/nodes");
    if (!r.ok) { setError((await j(r)).error ?? "failed to load"); return; }
    const d = await r.json();
    setNodes(d.nodes); setActor(d.actor);
  }, []);

  const loadMeta = useCallback(async () => {
    const r = await fetch("/api/v1/owned/meta");
    if (r.ok) { const d = await r.json(); setUsers(d.users); setGroups(d.groups); }
  }, []);

  useEffect(() => { (async () => { await Promise.all([loadNodes(), loadMeta()]); setLoading(false); })(); }, [loadNodes, loadMeta]);

  async function saveNode(form: typeof EMPTY & { id?: number }) {
    const body = {
      name: form.name.trim(), node_id: form.node_id.trim() || null, role: form.role, model: form.model || null,
      elevation: form.elevation || null, frequency: form.frequency, mqtt_topic: form.mqtt_topic || null,
      lat: form.lat === "" ? null : Number(form.lat), lng: form.lng === "" ? null : Number(form.lng),
      mqtt_connected: form.mqtt_connected, online: form.online, planned_site: form.planned_site,
      owner_type: form.owner_type,
      owner_user_id: form.owner_type === "user" && form.owner_user_id ? Number(form.owner_user_id) : null,
      owner_group_id: form.owner_type === "group" && form.owner_group_id ? Number(form.owner_group_id) : null,
    };
    const res = form.id ? await send(`/api/v1/owned/nodes/${form.id}`, "PATCH", body) : await send("/api/v1/owned/nodes", "POST", body);
    if (!res.ok) { setError(res.error!); return; }
    setEditing(null); setError(null); await loadNodes();
  }

  async function delNode(id: number) {
    if (!confirm("Delete this owned node and its issues/maintenance/shares?")) return;
    const res = await send(`/api/v1/owned/nodes/${id}`, "DELETE");
    if (!res.ok) { setError(res.error!); return; }
    await loadNodes();
  }

  if (loading) return <div className="card text-[13px] text-ink-faint">Loading owned nodes...</div>;

  const openEditor = (n?: OwnedNode) => setEditing(n ? {
    id: n.id, name: n.name, node_id: n.node_id ?? "", role: n.role, model: n.model ?? "", elevation: n.elevation ?? "",
    frequency: n.frequency, mqtt_topic: n.mqtt_topic ?? "", lat: n.lat == null ? "" : String(n.lat), lng: n.lng == null ? "" : String(n.lng),
    mqtt_connected: !!n.mqtt_connected, online: !!n.online, planned_site: !!n.planned_site,
    owner_type: n.owner_type, owner_user_id: n.owner_user_id ? String(n.owner_user_id) : "", owner_group_id: n.owner_group_id ? String(n.owner_group_id) : "",
  } : { ...EMPTY });

  const roleOpts = [...new Set(nodes.map((n) => n.role).filter(Boolean))].sort();
  const sortVal = (n: OwnedNode): string | number => {
    switch (sortKey) {
      case "name": return (n.name ?? "").toLowerCase();
      case "node_id": return n.num_id ?? 0;
      case "owner": return (n.owner_label ?? "").toLowerCase();
      case "role": return (n.role ?? "").toLowerCase();
      case "status": return (n.online ? 2 : 0) + (n.mqtt_connected ? 1 : 0);
      case "issues": return Number(n.open_issues ?? 0);
    }
  };
  const ql = q.trim().toLowerCase();
  const visible = nodes.filter((n) => {
    if (ownerFilter && String(n.owner_user_id ?? "") !== ownerFilter) return false;
    if (roleFilter && n.role !== roleFilter) return false;
    if (ql && !`${n.name} ${n.node_id ?? ""} ${n.owner_label ?? ""} ${n.role} ${n.observed_name ?? ""}`.toLowerCase().includes(ql)) return false;
    return true;
  }).sort((a, b) => { const d = sortDir === "asc" ? 1 : -1; const va = sortVal(a), vb = sortVal(b); return va < vb ? -d : va > vb ? d : 0; });
  const toggleSort = (k: typeof sortKey) => { if (sortKey === k) setSortDir((x) => (x === "asc" ? "desc" : "asc")); else { setSortKey(k); setSortDir("asc"); } };
  const arrow = (k: typeof sortKey) => (sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : "");
  const th = (k: typeof sortKey, label: string, cls = "") => (
    <th className={`cursor-pointer select-none px-3 py-2 hover:text-ink ${cls}`} onClick={() => toggleSort(k)}>{label}{arrow(k)}</th>
  );

  return (
    <div className="space-y-4">
      {error && <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[13px] text-accent-strong">{error}</div>}

      <div className="flex items-center gap-2">
        <button className={`btn h-8 px-3 text-[13px] ${tab === "nodes" ? "btn-primary" : "btn-outline"}`} onClick={() => setTab("nodes")}>Registry ({nodes.length})</button>
        <button className={`btn h-8 px-3 text-[13px] ${tab === "map" ? "btn-primary" : "btn-outline"}`} onClick={() => setTab("map")}>Map</button>
        <button className={`btn h-8 px-3 text-[13px] ${tab === "groups" ? "btn-primary" : "btn-outline"}`} onClick={() => setTab("groups")}>Groups ({groups.length})</button>
        {actor?.admin && <button className={`btn h-8 px-3 text-[13px] ${tab === "import" ? "btn-primary" : "btn-outline"}`} onClick={() => setTab("import")}>Import</button>}
        <div className="flex-1" />
        {actor && tab === "nodes" && <button className="btn btn-primary h-8 px-3 text-[13px]" onClick={() => openEditor()}>New node</button>}
      </div>

      {tab === "nodes" && actor?.admin && <BulkAssignPanel users={users} groups={groups} onDone={loadNodes} />}

      {tab === "nodes" && (
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID, owner, role..." className={`${inp} w-64`} />
          <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} className={`${inp}`}>
            <option value="">All owners</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
          </select>
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className={`${inp}`}>
            <option value="">All roles</option>
            {roleOpts.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {(q || ownerFilter || roleFilter) && <button className="btn btn-outline h-9 px-3 text-[13px]" onClick={() => { setQ(""); setOwnerFilter(""); setRoleFilter(""); }}>Clear</button>}
          <span className="text-[12px] text-ink-faint">{visible.length} of {nodes.length}</span>
        </div>
      )}

      {tab === "nodes" && (
        <section className="card overflow-x-auto p-0">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                {th("name", "Name")}{th("node_id", "Node ID")}{th("owner", "Owner")}
                {th("role", "Role")}{th("status", "Status")}{th("issues", "Issues")}<th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((n) => (
                <Fragment key={n.id}>
                  <tr className="border-b border-line/60 hover:bg-raised/40">
                    <td className="px-3 py-2">
                      <button className="text-left text-ink hover:text-accent" onClick={() => setExpanded(expanded === n.id ? null : n.id)}>
                        {n.name}{n.planned_site ? <span className="ml-1 text-[10px] text-ink-faint">(planned)</span> : null}
                      </button>
                      {n.observed_name && n.observed_name !== n.name && <div className="text-[11px] text-ink-faint">observed: {n.observed_name}</div>}
                    </td>
                    <td className="px-3 py-2 mono text-ink-mute">{n.node_id ?? "-"}</td>
                    <td className="px-3 py-2">
                      {n.owner_user_id && actor?.admin
                        ? <a className="text-accent hover:underline" href={`/my-reach?user=${n.owner_user_id}`} title="View this user's reach">{n.owner_label ?? "-"}</a>
                        : (n.owner_label ?? "-")}
                      {n.owner_type === "group" && <span className="ml-1 text-[10px] text-ink-faint">grp</span>}
                    </td>
                    <td className="px-3 py-2 text-ink-mute">{n.role}</td>
                    <td className="px-3 py-2">
                      <span className={n.online ? "text-ok" : "text-ink-faint"}>{n.online ? "online" : "offline"}</span>
                      {n.mqtt_connected ? <span className="ml-1 text-[10px] text-ink-faint">mqtt</span> : null}
                    </td>
                    <td className="px-3 py-2">{n.open_issues > 0 ? <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[11px] text-accent-strong">{n.open_issues} open</span> : <span className="text-ink-faint">-</span>}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {n.can_edit && <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => openEditor(n)}>Edit</button>}
                      {n.can_edit && <button className="btn btn-outline ml-1 h-7 px-2 text-[12px]" onClick={() => delNode(n.id)}>Delete</button>}
                    </td>
                  </tr>
                  {expanded === n.id && (
                    <tr><td colSpan={7} className="bg-raised/30 px-3 py-3">
                      <NodeDetail node={n} users={users} groups={groups} actor={actor} onChange={loadNodes} />
                    </td></tr>
                  )}
                </Fragment>
              ))}
              {visible.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-faint">{nodes.length === 0 ? "No owned nodes yet. Import from meshadmin or add one." : "No nodes match the filter."}</td></tr>}
            </tbody>
          </table>
        </section>
      )}

      {tab === "map" && <OwnedNodesMap nodes={nodes.map((n) => ({ id: n.id, name: n.name, node_id: n.node_id, role: n.role, owner_label: n.owner_label, lat: n.lat, lng: n.lng, online: n.online, planned_site: n.planned_site, open_issues: n.open_issues }))} tile={tile} />}

      {tab === "groups" && <GroupsPanel groups={groups} users={users} actor={actor} onChange={async () => { await loadMeta(); }} />}

      {tab === "import" && actor?.admin && <ImportMeshadminPanel onDone={async () => { await loadNodes(); await loadMeta(); }} />}

      {editing && (
        <NodeEditor form={editing} setForm={setEditing} users={users} groups={groups} actor={actor} onSave={saveNode} onCancel={() => { setEditing(null); setError(null); }} />
      )}
    </div>
  );
}

function BulkAssignPanel({ users, groups, onDone }: { users: UserOpt[]; groups: Group[]; onDone: () => Promise<void> }) {
  const [kind, setKind] = useState<"user" | "group">("user");
  const [ownerId, setOwnerId] = useState("");
  const [mode, setMode] = useState<"pattern" | "ids">("pattern");
  const [pattern, setPattern] = useState("");
  const [idsText, setIdsText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function assign() {
    setMsg(null); setBusy(true);
    const body: Record<string, unknown> = kind === "group" ? { owner_group_id: Number(ownerId) } : { owner_user_id: Number(ownerId) };
    if (mode === "pattern") body.short_name_pattern = pattern.trim();
    else body.node_ids = idsText.split(/[\s,]+/).filter(Boolean);
    const r = await fetch("/api/v1/owned/nodes/bulk-assign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await j(r);
    setBusy(false);
    if (r.ok) { setMsg(`Done: ${d.created} created, ${d.reassigned} reassigned (${d.matched} matched).`); await onDone(); }
    else setMsg(d.error ?? "failed");
  }

  const disabled = busy || !ownerId || (mode === "pattern" ? !pattern.trim() : !idsText.trim());
  return (
    <section className="card space-y-2">
      <h2 className="eyebrow"><span className="eyebrow-bar" />Bulk assign to a user or group</h2>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1"><span className="block stat-label">Assign to</span>
          <select value={kind} onChange={(e) => { setKind(e.target.value as "user" | "group"); setOwnerId(""); }} className={`${inp} w-24`}>
            <option value="user">User</option><option value="group">Group</option>
          </select>
        </label>
        <label className="space-y-1"><span className="block stat-label">{kind === "user" ? "User" : "Group"}</span>
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={`${inp} w-52`}>
            <option value="">(select {kind})</option>
            {kind === "user"
              ? users.map((u) => <option key={u.id} value={u.id}>{u.username}{u.discord_username ? ` (@${u.discord_username})` : ""}</option>)
              : groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <label className="space-y-1"><span className="block stat-label">Match by</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as "pattern" | "ids")} className={`${inp} w-40`}>
            <option value="pattern">short-name regex</option><option value="ids">node IDs</option>
          </select>
        </label>
        {mode === "pattern"
          ? <label className="min-w-[200px] flex-1 space-y-1"><span className="block stat-label">Short-name pattern (MySQL REGEXP)</span><input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="^RJ[0-9]+$" className={`${inp} w-full mono`} /></label>
          : <label className="min-w-[200px] flex-1 space-y-1"><span className="block stat-label">Node IDs (!hex or decimal, space/comma separated)</span><input value={idsText} onChange={(e) => setIdsText(e.target.value)} placeholder="!69854de0 !a696263c" className={`${inp} w-full mono`} /></label>}
        <button className="btn btn-primary h-9 px-4 text-[13px]" disabled={disabled} onClick={assign}>{busy ? "Assigning..." : "Assign"}</button>
      </div>
      <p className="text-[11px] text-ink-faint">Creates an owned record for any matched node not yet in the registry, and reassigns ones that already exist. Example: <span className="mono">^RJ[0-9]+$</span> assigns every node whose short name is RJ followed by a number.</p>
      {msg && <p className="text-[12px] text-ink">{msg}</p>}
    </section>
  );
}

function NodeEditor({ form, setForm, users, groups, actor, onSave, onCancel }: {
  form: typeof EMPTY & { id?: number }; setForm: (f: typeof EMPTY & { id?: number }) => void;
  users: UserOpt[]; groups: Group[]; actor: Actor | null; onSave: (f: typeof EMPTY & { id?: number }) => void; onCancel: () => void;
}) {
  const set = (k: string, v: unknown) => setForm({ ...form, [k]: v } as typeof form);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" onClick={onCancel}>
      <div className="card w-full max-w-xl space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="eyebrow"><span className="eyebrow-bar" />{form.id ? "Edit node" : "New node"}</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1"><span className="block stat-label">Name</span><input value={form.name} onChange={(e) => set("name", e.target.value)} className={`${inp} w-full`} /></label>
          <label className="space-y-1"><span className="block stat-label">Node ID (!hex)</span><input value={form.node_id} onChange={(e) => set("node_id", e.target.value)} placeholder="!a1b2c3d4" className={`${inp} w-full mono`} /></label>
          <label className="space-y-1"><span className="block stat-label">Role</span>
            <select value={form.role} onChange={(e) => set("role", e.target.value)} className={`${inp} w-full`}>
              {["Client", "Client Mute", "Router", "Router Client", "Repeater", "Tracker", "Sensor", "Gateway"].map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
          <label className="space-y-1"><span className="block stat-label">Model</span><input value={form.model} onChange={(e) => set("model", e.target.value)} className={`${inp} w-full`} /></label>
          <label className="space-y-1"><span className="block stat-label">Elevation</span><input value={form.elevation} onChange={(e) => set("elevation", e.target.value)} placeholder="e.g. 200ft tower" className={`${inp} w-full`} /></label>
          <label className="space-y-1"><span className="block stat-label">Frequency</span><input value={form.frequency} onChange={(e) => set("frequency", e.target.value)} className={`${inp} w-full`} /></label>
          <label className="space-y-1"><span className="block stat-label">MQTT topic</span><input value={form.mqtt_topic} onChange={(e) => set("mqtt_topic", e.target.value)} className={`${inp} w-full mono`} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1"><span className="block stat-label">Lat</span><input value={form.lat} onChange={(e) => set("lat", e.target.value)} className={`${inp} w-full`} /></label>
            <label className="space-y-1"><span className="block stat-label">Lng</span><input value={form.lng} onChange={(e) => set("lng", e.target.value)} className={`${inp} w-full`} /></label>
          </div>
        </div>

        {actor?.admin ? (
          <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
            <label className="space-y-1"><span className="block stat-label">Owner type</span>
              <select value={form.owner_type} onChange={(e) => set("owner_type", e.target.value)} className={`${inp} w-full`}>
                <option value="user">User</option><option value="group">Group</option>
              </select>
            </label>
            {form.owner_type === "user" ? (
              <label className="space-y-1"><span className="block stat-label">Owner (Discord account)</span>
                <select value={form.owner_user_id} onChange={(e) => set("owner_user_id", e.target.value)} className={`${inp} w-full`}>
                  <option value="">(none)</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.username}{u.discord_username ? ` (@${u.discord_username})` : ""}</option>)}
                </select>
              </label>
            ) : (
              <label className="space-y-1"><span className="block stat-label">Owner group</span>
                <select value={form.owner_group_id} onChange={(e) => set("owner_group_id", e.target.value)} className={`${inp} w-full`}>
                  <option value="">(none)</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
            )}
          </div>
        ) : !form.id ? (
          <p className="border-t border-line pt-3 text-[12px] text-ink-faint">This node will be owned by you ({actor?.username}). An admin can reassign ownership.</p>
        ) : null}

        <div className="flex flex-wrap gap-4 border-t border-line pt-3 text-[13px] text-ink">
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.online} onChange={(e) => set("online", e.target.checked)} /> Online</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.mqtt_connected} onChange={(e) => set("mqtt_connected", e.target.checked)} /> MQTT connected</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.planned_site} onChange={(e) => set("planned_site", e.target.checked)} /> Planned site</label>
        </div>

        <div className="flex items-center gap-3">
          <button className="btn btn-primary h-9 px-4 text-[13px]" disabled={!form.name.trim()} onClick={() => onSave(form)}>Save</button>
          <button className="btn btn-outline h-9 px-4 text-[13px]" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function NodeDetail({ node, users, groups, actor, onChange }: { node: OwnedNode; users: UserOpt[]; groups: Group[]; actor: Actor | null; onChange: () => void }) {
  const [shares, setShares] = useState<Share[]>([]);
  const [maint, setMaint] = useState<Maintenance[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const base = `/api/v1/owned/nodes/${node.id}`;

  const reload = useCallback(async () => {
    const [mi, is] = await Promise.all([fetch(`${base}/maintenance`).then(j), fetch(`${base}/issues`).then(j)]);
    setMaint(mi.maintenance ?? []); setIssues(is.issues ?? []);
    if (node.can_edit) { const s = await fetch(`${base}/shares`).then(j); setShares(s.shares ?? []); }
  }, [base, node.can_edit]);
  useEffect(() => { reload(); }, [reload]);

  const act = async (p: Promise<{ ok: boolean; error?: string }>) => { const r = await p; if (!r.ok) setErr(r.error!); else { setErr(null); await reload(); onChange(); } };

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {err && <div className="md:col-span-3 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[12px] text-accent-strong">{err}</div>}

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
            {node.can_edit && (
              <div className="mt-1 flex gap-1">
                {["open", "in_progress", "resolved", "closed"].filter((s) => s !== it.status).map((s) => (
                  <button key={s} className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-mute hover:text-ink" onClick={() => act(send(`${base}/issues`, "PATCH", { issue_id: it.id, status: s }))}>{s}</button>
                ))}
                <button className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-mute hover:text-accent-strong" onClick={() => act(send(`${base}/issues?issue_id=${it.id}`, "DELETE"))}>del</button>
              </div>
            )}
          </div>
        ))}
        {issues.length === 0 && <p className="text-[12px] text-ink-faint">No issues.</p>}
        {actor && <IssueAdd onAdd={(t, d) => act(send(`${base}/issues`, "POST", { issue_type: t, description: d }))} />}
      </div>

      {/* Maintenance */}
      <div className="space-y-2">
        <div className="stat-label">Maintenance log</div>
        {maint.map((m) => (
          <div key={m.id} className="rounded-md border border-line p-2 text-[12px]">
            <div className="flex items-center justify-between"><span className="text-ink">{fmtDate(m.visit_date)}</span>{node.can_edit && <button className="text-[10px] text-ink-faint hover:text-accent-strong" onClick={() => act(send(`${base}/maintenance?entry_id=${m.id}`, "DELETE"))}>del</button>}</div>
            {m.notes && <p className="mt-1 text-ink-mute">{m.notes}</p>}
            <div className="mt-1 text-[10px] text-ink-faint">{m.username ?? "?"}</div>
          </div>
        ))}
        {maint.length === 0 && <p className="text-[12px] text-ink-faint">No visits logged.</p>}
        {node.can_edit && <MaintAdd onAdd={(date, notes) => act(send(`${base}/maintenance`, "POST", { visit_date: date, notes }))} />}
      </div>

      {/* Sharing */}
      <div className="space-y-2">
        <div className="stat-label">Sharing</div>
        {!node.can_edit && <p className="text-[12px] text-ink-faint">Only the owner or an admin can manage sharing.</p>}
        {node.can_edit && (
          <>
            {shares.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-md border border-line p-2 text-[12px]">
                <span className="text-ink">{s.label} <span className="text-ink-faint">({s.group_id ? "group" : "user"}, {s.permission_level})</span></span>
                <button className="text-[10px] text-ink-faint hover:text-accent-strong" onClick={() => act(send(`${base}/shares?share_id=${s.id}`, "DELETE"))}>remove</button>
              </div>
            ))}
            {shares.length === 0 && <p className="text-[12px] text-ink-faint">Not shared.</p>}
            <ShareAdd users={users} groups={groups} onAdd={(body) => act(send(`${base}/shares`, "POST", body))} />
          </>
        )}
      </div>
    </div>
  );
}

function IssueAdd({ onAdd }: { onAdd: (type: string, desc: string) => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("");
  const [desc, setDesc] = useState("");
  if (!open) return <button className="text-[12px] text-accent hover:underline" onClick={() => setOpen(true)}>+ Report issue</button>;
  return (
    <div className="space-y-1">
      <input value={type} onChange={(e) => setType(e.target.value)} placeholder="Issue type (e.g. offline, hardware)" className={`${inp} w-full`} />
      <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description" className={`${inp} h-14 w-full py-1`} />
      <div className="flex gap-2"><button className="btn btn-primary h-7 px-2 text-[12px]" disabled={!type.trim()} onClick={() => { onAdd(type, desc); setType(""); setDesc(""); setOpen(false); }}>Add</button><button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>
  );
}

function MaintAdd({ onAdd }: { onAdd: (date: string, notes: string) => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  if (!open) return <button className="text-[12px] text-accent hover:underline" onClick={() => setOpen(true)}>+ Log visit</button>;
  return (
    <div className="space-y-1">
      <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} className={`${inp} w-full`} />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was done" className={`${inp} h-14 w-full py-1`} />
      <div className="flex gap-2"><button className="btn btn-primary h-7 px-2 text-[12px]" onClick={() => { onAdd(date, notes); setDate(""); setNotes(""); setOpen(false); }}>Add</button><button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>
  );
}

function ShareAdd({ users, groups, onAdd }: { users: UserOpt[]; groups: Group[]; onAdd: (body: Record<string, unknown>) => void }) {
  const [kind, setKind] = useState<"user" | "group">("user");
  const [target, setTarget] = useState("");
  const [level, setLevel] = useState<"view" | "edit">("view");
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

function GroupsPanel({ groups, users, actor, onChange }: { groups: Group[]; users: UserOpt[]; actor: Actor | null; onChange: () => void }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [manage, setManage] = useState<number | null>(null);
  const [members, setMembers] = useState<{ user_id: number; username: string }[]>([]);
  const [addUser, setAddUser] = useState("");

  const act = async (p: Promise<{ ok: boolean; error?: string }>) => { const r = await p; if (!r.ok) setErr(r.error!); else { setErr(null); onChange(); } };
  const loadMembers = async (gid: number) => { const d = await fetch(`/api/v1/owned/groups/${gid}/members`).then(j); setMembers(d.members ?? []); setManage(gid); };

  return (
    <section className="card space-y-3">
      {err && <div className="rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[12px] text-accent-strong">{err}</div>}
      {actor && (
        <div className="flex flex-wrap items-end gap-2 border-b border-line pb-3">
          <label className="space-y-1"><span className="block stat-label">New group</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={`${inp} w-44`} /></label>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)" className={`${inp} flex-1`} />
          <button className="btn btn-primary h-9 px-3 text-[13px]" disabled={!name.trim()} onClick={async () => { await act(send("/api/v1/owned/groups", "POST", { name, description: desc })); setName(""); setDesc(""); }}>Create</button>
        </div>
      )}
      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g.id} className="rounded-md border border-line p-2 text-[13px]">
            <div className="flex items-center justify-between">
              <div><span className="font-medium text-ink">{g.name}</span> <span className="text-[11px] text-ink-faint">{g.member_count} members · by {g.creator ?? "?"}</span>{g.description && <p className="text-[12px] text-ink-mute">{g.description}</p>}</div>
              <div className="flex gap-1">
                {(actor?.admin || (actor && Number(g.created_by) === actor.id)) && <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => (manage === g.id ? setManage(null) : loadMembers(g.id))}>Members</button>}
                {(actor?.admin || (actor && Number(g.created_by) === actor.id)) && <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => { if (confirm("Delete group?")) act(send(`/api/v1/owned/groups?group_id=${g.id}`, "DELETE")); }}>Delete</button>}
              </div>
            </div>
            {manage === g.id && (
              <div className="mt-2 space-y-1 border-t border-line pt-2">
                {members.map((m) => (
                  <div key={m.user_id} className="flex items-center justify-between text-[12px]"><span className="text-ink">{m.username}</span><button className="text-[10px] text-ink-faint hover:text-accent-strong" onClick={async () => { await act(send(`/api/v1/owned/groups/${g.id}/members?user_id=${m.user_id}`, "DELETE")); await loadMembers(g.id); }}>remove</button></div>
                ))}
                {members.length === 0 && <p className="text-[12px] text-ink-faint">No members.</p>}
                <div className="flex items-center gap-1">
                  <select value={addUser} onChange={(e) => setAddUser(e.target.value)} className={`${inp} h-8 flex-1`}><option value="">add member...</option>{users.filter((u) => !members.some((m) => m.user_id === u.id)).map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}</select>
                  <button className="btn btn-primary h-8 px-2 text-[12px]" disabled={!addUser} onClick={async () => { await act(send(`/api/v1/owned/groups/${g.id}/members`, "POST", { user_id: Number(addUser) })); setAddUser(""); await loadMembers(g.id); }}>Add</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {groups.length === 0 && <p className="text-[13px] text-ink-faint">No groups yet.</p>}
      </div>
    </section>
  );
}
