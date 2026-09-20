"use client";

import { useState } from "react";

interface User {
  id: number;
  username: string;
  role: string;
  created_at: string;
  discord_username: string | null;
  has_password: number;
}
interface Role { key: string; label: string; admin: boolean }

const inputCls = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";

// Admin user management: password accounts + Discord-provisioned accounts, each re-rollable.
export function UsersManager({ initial, currentUser, roles }: { initial: User[]; currentUser: string; roles: Role[] }) {
  const [users, setUsers] = useState<User[]>(initial);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<string>(roles.find((r) => !r.admin)?.key ?? roles[0]?.key ?? "viewer");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function refresh() {
    const r = await fetch("/api/v1/admin/users");
    if (r.ok) setUsers((await r.json()).users);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setNote(null);
    const res = await fetch("/api/v1/admin/users", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password, role }),
    });
    if (res.ok) { setNote(`saved ${username}`); setUsername(""); setPassword(""); await refresh(); }
    else setError((await res.json().catch(() => ({}))).error ?? "save failed");
  }

  async function changeRole(u: string, newRole: string) {
    setError(null); setNote(null);
    // optimistic
    setUsers((prev) => prev.map((x) => (x.username === u ? { ...x, role: newRole } : x)));
    const res = await fetch("/api/v1/admin/users", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: u, role: newRole }),
    });
    if (res.ok) setNote(`updated ${u}`);
    else { setError((await res.json().catch(() => ({}))).error ?? "update failed"); await refresh(); }
  }

  async function remove(u: string) {
    if (!confirm(`Delete user "${u}"?`)) return;
    const res = await fetch(`/api/v1/admin/users?username=${encodeURIComponent(u)}`, { method: "DELETE" });
    if (res.ok) await refresh();
    else setError((await res.json().catch(() => ({}))).error ?? "delete failed");
  }

  return (
    <div className="card">
      <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Users &amp; access</h2>
      {error && <p className="mb-2 text-xs text-accent-strong">{error}</p>}
      {note && <p className="mb-2 text-xs text-ok">{note}</p>}
      <table className="data">
        <thead>
          <tr><th>Username</th><th>Sign-in</th><th>Role</th><th></th></tr>
        </thead>
        <tbody>
          {users.length === 0 && <tr><td colSpan={4} className="text-ink-faint">No users.</td></tr>}
          {users.map((u) => {
            const isSelf = u.username === currentUser;
            return (
              <tr key={u.id}>
                <td className="mono">
                  {u.username}
                  {isSelf && <span className="ml-2 text-[11px] text-ink-faint">(you)</span>}
                </td>
                <td className="text-ink-mute">
                  {u.has_password ? "password" : "Discord"}
                  {u.discord_username && <span className="ml-1 text-[11px] text-ink-faint">{u.discord_username}</span>}
                </td>
                <td>
                  <select
                    className={inputCls + " h-8"}
                    value={roles.some((r) => r.key === u.role) ? u.role : ""}
                    disabled={isSelf}
                    onChange={(e) => changeRole(u.username, e.target.value)}
                  >
                    {!roles.some((r) => r.key === u.role) && <option value="">{u.role} (unknown)</option>}
                    {roles.map((r) => <option key={r.key} value={r.key}>{r.label}{r.admin ? " (admin)" : ""}</option>)}
                  </select>
                </td>
                <td className="text-right">
                  {!isSelf && <button className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => remove(u.username)}>Delete</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <form className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4" onSubmit={save}>
        <label className="space-y-1"><span className="block stat-label">Username</span>
          <input className={inputCls + " w-40"} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="alice" autoComplete="off" />
        </label>
        <label className="space-y-1"><span className="block stat-label">Password</span>
          <input className={inputCls + " w-48"} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 8 chars" autoComplete="new-password" />
        </label>
        <label className="space-y-1"><span className="block stat-label">Role</span>
          <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => <option key={r.key} value={r.key}>{r.label}{r.admin ? " (admin)" : ""}</option>)}
          </select>
        </label>
        <button className="btn btn-primary h-9 px-4 text-[13px]" type="submit">Save user</button>
      </form>
      <p className="mt-2 text-[11px] text-ink-faint">
        Adding an existing username resets their password and role. Change any user's role inline (including
        Discord logins); you cannot change your own admin role or demote the last admin. Roles and their module
        access are defined under Roles &amp; access.
      </p>
    </div>
  );
}
