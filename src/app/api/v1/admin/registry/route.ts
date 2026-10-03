import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Instance-registry settings. announce.* makes this instance report to a hub; hub.* makes this
// instance accept heartbeats and show the /admin/instances directory. Nothing here is a secret.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const r = (await effectiveConfig()).registry;
  return NextResponse.json({
    announce: {
      enabled: r.announce.enabled,
      hub_url: r.announce.hub_url,
      name: r.announce.name,
      public_url: r.announce.public_url,
      interval_minutes: r.announce.interval_minutes,
    },
    hub: { enabled: r.hub.enabled, stale_days: r.hub.stale_days },
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as any;
  if (!b || typeof b !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const patch = {
    registry: {
      announce: {
        enabled: !!b.announce?.enabled,
        hub_url: String(b.announce?.hub_url ?? "").trim(),
        name: String(b.announce?.name ?? "").trim(),
        public_url: String(b.announce?.public_url ?? "").trim(),
        interval_minutes: Math.max(1, Number(b.announce?.interval_minutes ?? 360) || 360),
      },
      hub: {
        enabled: !!b.hub?.enabled,
        stale_days: Math.max(0, Number(b.hub?.stale_days ?? 30) || 0),
      },
    },
  };

  try {
    await saveOverrides(patch);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
