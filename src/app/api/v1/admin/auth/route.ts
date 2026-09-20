import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Discord SSO config + session lifetime. The client secret is encrypted at rest and never
// returned; only has_secret is exposed.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const a = (await effectiveConfig()).server.auth;
  return NextResponse.json({
    discord: { enabled: a.discord.enabled, client_id: a.discord.client_id, redirect_url: a.discord.redirect_url, has_secret: !!a.discord.client_secret, auto_provision: a.discord.auto_provision },
    session_ttl_hours: a.session_ttl_hours,
    anonymous_read_only: a.anonymous_read_only,
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const ttl = Number(b.session_ttl_hours);
  const discord: Record<string, unknown> = {
    enabled: !!b.discord?.enabled,
    client_id: String(b.discord?.client_id ?? "").trim().slice(0, 64),
    redirect_url: String(b.discord?.redirect_url ?? "").trim().slice(0, 300),
    auto_provision: b.discord?.auto_provision !== false,
  };
  // Only set the secret when a new one is provided; blank keeps the stored (encrypted) one.
  if (typeof b.discord?.client_secret === "string" && b.discord.client_secret !== "") discord.client_secret = b.discord.client_secret;

  try {
    await saveOverrides({
      server: { auth: { session_ttl_hours: Number.isFinite(ttl) ? Math.min(8760, Math.max(1, Math.floor(ttl))) : 720, anonymous_read_only: b.anonymous_read_only !== false, discord } },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
