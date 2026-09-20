import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { listUsers, upsertUser, deleteUser, setUserRole } from "../../../../../auth/users.ts";
import { effectiveConfig } from "../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin user management. Passwords are scrypt-hashed; never returned to the client. Roles are
// RBAC role keys (from /admin/roles); "admin"-flagged roles grant the admin surface.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const cfg = await effectiveConfig();
  return NextResponse.json({
    users: await listUsers(),
    roles: cfg.rbac.roles.map((r) => ({ key: r.key, label: r.label, admin: !!r.admin })),
    currentUser: guard.session.sub,
  });
}

async function validRoleKeys(): Promise<Set<string>> {
  const cfg = await effectiveConfig();
  return new Set(cfg.rbac.roles.map((r) => r.key));
}
async function adminRoleKeys(): Promise<Set<string>> {
  const cfg = await effectiveConfig();
  return new Set(cfg.rbac.roles.filter((r) => r.admin).map((r) => r.key));
}

// Create a password user, or reset an existing user's password + role.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as { username?: string; password?: string; role?: string } | null;
  if (!b || typeof b.username !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(b.username)) {
    return NextResponse.json({ error: "username must be 1-64 chars [a-zA-Z0-9_.-]" }, { status: 400 });
  }
  if (typeof b.password !== "string" || b.password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  }
  const keys = await validRoleKeys();
  const role = b.role && keys.has(b.role) ? b.role : "viewer";
  await upsertUser(b.username, b.password, role);
  return NextResponse.json({ ok: true, username: b.username, role });
}

// Change a user's role only (works for Discord/self-provisioned accounts that have no password).
export async function PATCH(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as { username?: string; role?: string } | null;
  if (!b || typeof b.username !== "string" || typeof b.role !== "string") {
    return NextResponse.json({ error: "username and role required" }, { status: 400 });
  }
  const keys = await validRoleKeys();
  if (!keys.has(b.role)) return NextResponse.json({ error: "unknown role" }, { status: 400 });

  const users = await listUsers();
  const target = users.find((u) => u.username === b.username);
  if (!target) return NextResponse.json({ error: "unknown user" }, { status: 404 });

  const adminKeys = await adminRoleKeys();
  const targetIsAdmin = adminKeys.has(target.role);
  const newIsAdmin = adminKeys.has(b.role);
  // Never let an admin strip their own admin role (avoids self-lockout).
  if (b.username === guard.session.sub && targetIsAdmin && !newIsAdmin) {
    return NextResponse.json({ error: "cannot change your own admin role" }, { status: 400 });
  }
  // Never demote the last admin.
  if (targetIsAdmin && !newIsAdmin && users.filter((u) => adminKeys.has(u.role)).length <= 1) {
    return NextResponse.json({ error: "cannot demote the last admin" }, { status: 400 });
  }
  await setUserRole(b.username, b.role);
  return NextResponse.json({ ok: true, username: b.username, role: b.role });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const username = req.nextUrl.searchParams.get("username");
  if (!username) return NextResponse.json({ error: "username required" }, { status: 400 });
  if (username === guard.session.sub) return NextResponse.json({ error: "cannot delete the account you are signed in as" }, { status: 400 });
  const users = await listUsers();
  const adminKeys = await adminRoleKeys();
  const target = users.find((u) => u.username === username);
  if (target && adminKeys.has(target.role) && users.filter((u) => adminKeys.has(u.role)).length <= 1) {
    return NextResponse.json({ error: "cannot delete the last admin" }, { status: 400 });
  }
  await deleteUser(username);
  return NextResponse.json({ ok: true, username });
}
