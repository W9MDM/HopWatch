import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";
import { MODULE_KEYS, MODULES } from "../../../../../auth/modules.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const cfg = await effectiveConfig();
  return NextResponse.json({ rbac: cfg.rbac, modules: MODULES });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!b || !Array.isArray(b.roles)) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const modSet = new Set(MODULE_KEYS);
  const seen = new Set<string>();
  const roles = [] as { key: string; label: string; admin: boolean; can_tx: boolean; modules: string[] }[];
  for (const r of b.roles) {
    const key = String(r.key ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    roles.push({
      key,
      label: String(r.label ?? key).slice(0, 40),
      admin: !!r.admin,
      can_tx: !!r.can_tx,
      modules: Array.isArray(r.modules) ? r.modules.filter((m: unknown) => typeof m === "string" && modSet.has(m)) : [],
    });
  }
  // Never let the admin lock everyone out: at least one admin role must remain.
  if (!roles.some((r) => r.admin)) return NextResponse.json({ error: "at least one role must have admin" }, { status: 400 });

  // Anonymous and default-token roles must never be an admin role (that would grant every
  // unauthenticated request admin-level module access).
  const nonAdmin = (k: string) => roles.some((r) => r.key === k && !r.admin);
  const fallback = roles.find((r) => !r.admin)?.key ?? roles[0]!.key;
  const anon = String(b.anonymous_role ?? "public");
  const anonymous_role = nonAdmin(anon) ? anon : fallback;
  const tokenDef = String(b.token_default_role ?? "viewer");
  const token_default_role = nonAdmin(tokenDef) ? tokenDef : anonymous_role;
  // Signed-in non-admin accounts (incl. auto-provisioned Discord logins) map here; must be non-admin.
  const mem = String(b.member_role ?? "member");
  const member_role = nonAdmin(mem) ? mem : (roles.find((r) => r.key === "member" && !r.admin)?.key ?? anonymous_role);

  try {
    await saveOverrides({ rbac: { roles, anonymous_role, token_default_role, member_role } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
