"use client";

import { useState } from "react";

export interface Role { key: string; label: string; admin: boolean; can_tx: boolean; modules: string[] }
interface ModuleDef { key: string; label: string; category: string }

export function RolesManager({ initialRoles, anonymousRole, tokenDefaultRole, memberRole, modules }: {
  initialRoles: Role[]; anonymousRole: string; tokenDefaultRole: string; memberRole: string; modules: ModuleDef[];
}) {
  const [roles, setRoles] = useState<Role[]>(initialRoles.map((r) => ({ ...r, modules: [...r.modules] })));
  const [anon, setAnon] = useState(anonymousRole);
  const [tokenDef, setTokenDef] = useState(tokenDefaultRole);
  const [member, setMember] = useState(memberRole);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cats = [...new Set(modules.map((m) => m.category))];
  const update = (i: number, patch: Partial<Role>) => setRoles(roles.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggleMod = (i: number, key: string) => {
    const r = roles[i]!;
    update(i, { modules: r.modules.includes(key) ? r.modules.filter((m) => m !== key) : [...r.modules, key] });
  };
  const addRole = () => {
    const key = `role${roles.length + 1}`;
    setRoles([...roles, { key, label: key, admin: false, can_tx: false, modules: [] }]);
  };
  const removeRole = (i: number) => setRoles(roles.filter((_, j) => j !== i));

  async function save() {
    setMsg(null); setError(null);
    const r = await fetch("/api/v1/admin/roles", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ roles, anonymous_role: anon, token_default_role: tokenDef, member_role: member }),
    });
    if (r.ok) setMsg("Saved. Access changes apply immediately.");
    else setError((await r.json().catch(() => ({}))).error ?? "save failed");
  }

  const sel = "h-9 rounded-md border border-line bg-raised px-2 text-[13px] text-ink";

  return (
    <section className="space-y-4">
      <div className="card flex flex-wrap items-end gap-4">
        <label className="space-y-1"><span className="block stat-label">Anonymous role</span>
          <select className={sel} value={anon} onChange={(e) => setAnon(e.target.value)}>{roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
        </label>
        <label className="space-y-1"><span className="block stat-label">Default token role</span>
          <select className={sel} value={tokenDef} onChange={(e) => setTokenDef(e.target.value)}>{roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
        </label>
        <label className="space-y-1"><span className="block stat-label">Signed-in member role</span>
          <select className={sel} value={member} onChange={(e) => setMember(e.target.value)}>{roles.filter((r) => !r.admin).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
        </label>
        <button className="btn btn-outline h-9 px-3 text-[13px]" onClick={addRole}>Add role</button>
        <div className="ml-auto flex items-center gap-3">
          <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save roles</button>
          {msg && <span className="text-[12px] text-ok">{msg}</span>}
          {error && <span className="text-[12px] text-accent-strong">{error}</span>}
        </div>
      </div>

      {roles.map((r, i) => (
        <div key={i} className="card space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <input className="h-9 w-40 rounded-md border border-line bg-raised px-3 text-[13px] text-ink" value={r.label} onChange={(e) => update(i, { label: e.target.value })} />
            <input className="h-9 w-32 rounded-md border border-line bg-raised px-3 font-mono text-[12px] text-ink-mute" value={r.key} onChange={(e) => update(i, { key: e.target.value })} placeholder="key" />
            <label className="flex items-center gap-1 text-[13px] text-ink"><input type="checkbox" checked={r.admin} onChange={(e) => update(i, { admin: e.target.checked })} /> admin (all modules)</label>
            <label className="flex items-center gap-1 text-[13px] text-ink"><input type="checkbox" checked={r.can_tx} onChange={(e) => update(i, { can_tx: e.target.checked })} /> can transmit</label>
            <button className="ml-auto btn btn-outline h-8 px-3 text-[12px]" onClick={() => removeRole(i)}>Remove</button>
          </div>
          {!r.admin && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {cats.map((cat) => (
                <div key={cat}>
                  <div className="stat-label mb-1">{cat}</div>
                  <div className="space-y-0.5">
                    {modules.filter((m) => m.category === cat).map((m) => (
                      <label key={m.key} className="flex items-center gap-1.5 text-[12px] text-ink-mute">
                        <input type="checkbox" checked={r.modules.includes(m.key)} onChange={() => toggleMod(i, m.key)} /> {m.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
