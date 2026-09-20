import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEALTH_KEYS = ["utilization", "delivery_ratio", "gateway_coverage", "active_node_trend", "anomalies"] as const;

// Analytics tuning: spam-score window, records toggle, health-score weights. DB-backed override
// (admin-editable, hot-reloads via effectiveConfig on the worker). No env var, no YAML source.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const a = (await effectiveConfig()).analytics;
  return NextResponse.json({
    spam_score: { window_hours: a.spam_score.window_hours },
    records: { enabled: a.records.enabled },
    health_score: { weights: a.health_score.weights },
    rollups: { refold_hours: a.rollups.refold_hours },
  });
}

const num = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!b || typeof b !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });

  // Clamp each health weight to [0,1]; keep only the known keys so the record stays well-formed.
  const weights: Record<string, number> = {};
  for (const k of HEALTH_KEYS) weights[k] = num(b.health_score?.weights?.[k], 0, 0, 1);

  const patch = {
    analytics: {
      spam_score: { window_hours: num(b.spam_score?.window_hours, 24, 1, 720) },
      records: { enabled: b.records?.enabled !== false },
      health_score: { weights },
      rollups: { refold_hours: Math.round(num(b.rollups?.refold_hours, 6, 0, 168)) },
    },
  };

  try {
    await saveOverrides(patch);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
