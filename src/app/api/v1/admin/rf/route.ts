import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const cfg = await effectiveConfig();
  return NextResponse.json({ rf: cfg.rf, coverage: cfg.coverage });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const patch = {
    rf: {
      link_budget: {
        enabled: !!b.link_budget?.enabled,
        max_distance_km: num(b.link_budget?.max_distance_km, 60, 1, 500),
        terrain: !!b.link_budget?.terrain,
        antenna_height_m: num(b.link_budget?.antenna_height_m, 3, 0, 1000),
        elevation_url: String(b.link_budget?.elevation_url ?? "https://api.open-elevation.com/api/v1/lookup").slice(0, 300),
      },
      propagation: {
        enabled: !!b.propagation?.enabled,
        baseline_window_hours: num(b.propagation?.baseline_window_hours, 24, 1, 720),
        improvement_threshold_db: num(b.propagation?.improvement_threshold_db, 10, 1, 60),
        dx_distance_threshold_km: num(b.propagation?.dx_distance_threshold_km, 25, 1, 500),
      },
      weather: {
        enabled: !!b.weather?.enabled,
        stations: Array.isArray(b.weather?.stations)
          ? b.weather.stations.map((s: unknown) => String(s).trim().toUpperCase()).filter(Boolean).slice(0, 50)
          : [],
      },
      space_weather: {
        enabled: !!b.space_weather?.enabled,
        refresh_interval_minutes: num(b.space_weather?.refresh_interval_minutes, 30, 5, 1440),
        kp_url: String(b.space_weather?.kp_url ?? "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json").slice(0, 300),
        flux_url: String(b.space_weather?.flux_url ?? "https://services.swpc.noaa.gov/products/summary/10cm-flux.json").slice(0, 300),
        solar_wind_url: String(b.space_weather?.solar_wind_url ?? "https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json").slice(0, 300),
      },
    },
    coverage: {
      default_eirp_dbm: num(b.coverage?.default_eirp_dbm, 30, -20, 60),
      default_height_m: num(b.coverage?.default_height_m, 8, 0, 1000),
      rx_height_m: num(b.coverage?.rx_height_m, 2, 0, 1000),
      rx_sensitivity_dbm: num(b.coverage?.rx_sensitivity_dbm, -128, -160, -60),
      path_loss_exponent: num(b.coverage?.path_loss_exponent, 2.7, 1.5, 6),
      reference_loss_db_1km: num(b.coverage?.reference_loss_db_1km, 100, 60, 160),
      max_radius_km: num(b.coverage?.max_radius_km, 60, 1, 500),
    },
  };
  try {
    await saveOverrides(patch);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
