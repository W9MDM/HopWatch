import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

// Traceroute settings: the manual-traceroute cooldown plus the auto-traceroute config. Patches
// only tx.traceroute_cooldown_s and tx.auto_traceroute (saveOverrides deep-merges).
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const tx = (await effectiveConfig()).tx;
  return NextResponse.json({ traceroute_cooldown_s: tx.traceroute_cooldown_s, auto_traceroute: tx.auto_traceroute });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const patch = {
    tx: {
      traceroute_cooldown_s: num(b.traceroute_cooldown_s, 300, 0, 86400),
      auto_traceroute: {
        enabled: !!b.auto_traceroute?.enabled,
        send_every_minutes: num(b.auto_traceroute?.send_every_minutes, 5, 1, 10080),
        interval_hours: num(b.auto_traceroute?.interval_hours, 24, 1, 8760),
        max_per_run: num(b.auto_traceroute?.max_per_run, 3, 1, 50),
        max_active_age_hours: num(b.auto_traceroute?.max_active_age_hours, 24, 1, 8760),
        transport: b.auto_traceroute?.transport === "mqtt" ? "mqtt" : "rf",
        only_routers: !!b.auto_traceroute?.only_routers,
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
