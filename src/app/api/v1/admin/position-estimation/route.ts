import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Position-estimation settings. DB-backed config override (admin-editable, hot-reloads via
// effectiveConfig on ingest/worker/web). No env var, no YAML source of truth.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const cfg = await effectiveConfig();
  return NextResponse.json({ position_estimation: cfg.position_estimation });
}

const num = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const patch = {
    position_estimation: {
      enabled: !!b.enabled,
      window_days: num(b.window_days, 7, 1, 90),
      recompute_interval_minutes: num(b.recompute_interval_minutes, 60, 5, 1440),
      path_loss_exponent: num(b.path_loss_exponent, 2.7, 1.5, 6),
      reference_loss_db_1km: num(b.reference_loss_db_1km, 100, 60, 160),
      min_receptions_per_pair: num(b.min_receptions_per_pair, 5, 1, 1000),
      mobile_variance_threshold_db: num(b.mobile_variance_threshold_db, 12, 1, 60),
      use_terrain_refinement: !!b.use_terrain_refinement,
      feed_coverage_heatmap: !!b.feed_coverage_heatmap,
    },
  };

  try {
    await saveOverrides(patch);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
