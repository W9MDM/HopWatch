import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const validTz = (tz: string): boolean => {
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
};
// Default map center. lat/lon are both-or-neither: unless both are finite and in range, the
// center is cleared to null (auto-fit). Zoom is clamped.
function mapCenter(c: unknown): { lat: number | null; lon: number | null; zoom: number } {
  const o = (c ?? {}) as Record<string, unknown>;
  const lat = Number(o.lat), lon = Number(o.lon);
  const ok = Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  return { lat: ok ? lat : null, lon: ok ? lon : null, zoom: num(o.zoom, 9, 0, 20) };
}
// A header social link: only http(s) URLs are kept (blocks javascript:/data: in an href); empty
// otherwise, which hides the icon.
function socialUrl(v: unknown): string {
  const s = String(v ?? "").trim().slice(0, 300);
  return /^https?:\/\//i.test(s) ? s : "";
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const cfg = await effectiveConfig();
  const an = cfg.server.ui.analytics;
  return NextResponse.json({
    display: { brand_name: cfg.server.ui.brand_name, brand_icon: cfg.server.ui.brand_icon, local_timezone: cfg.server.local_timezone, public_url: cfg.server.public_url, tile: cfg.server.ui.tile_provider, tile_dark: cfg.server.ui.tile_provider_dark, temperature_unit: cfg.server.ui.temperature_unit },
    analytics: { enabled: an.enabled, measurement_id: an.measurement_id, client: an.client, server: an.server, has_api_secret: !!an.api_secret },
    map_max_age: cfg.server.ui.map_max_age,
    map_center: cfg.server.ui.map_center,
    social_links: cfg.server.ui.social_links,
    privacy: { metrics_public: cfg.server.metrics_public, fuzz_positions: cfg.server.privacy.fuzz_positions, fuzz_decimals: cfg.server.privacy.fuzz_decimals },
    retention: cfg.retention,
    features: cfg.features,
    livemap: cfg.livemap,
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const tz = String(b.display?.local_timezone ?? "UTC");
  if (!validTz(tz)) return NextResponse.json({ error: "invalid IANA timezone" }, { status: 400 });
  // Brand icon: a data:image/ URI or an http(s) image URL. Capped so it stays reasonable in
  // the config_overrides JSON (base64 icons should be small: use a 64x64-ish PNG/SVG).
  const iconRaw = String(b.display?.brand_icon ?? "").trim();
  if (iconRaw && !/^data:image\//i.test(iconRaw) && !/^https?:\/\//i.test(iconRaw)) {
    return NextResponse.json({ error: "brand icon must be an image data URI or an http(s) URL" }, { status: 400 });
  }
  if (iconRaw.length > 200_000) return NextResponse.json({ error: "brand icon too large (max ~150KB image)" }, { status: 400 });
  const tileUrl = String(b.display?.tile?.url_template ?? "");
  if (!(tileUrl.includes("{z}") && tileUrl.includes("{x}") && tileUrl.includes("{y}"))) {
    return NextResponse.json({ error: "tile URL must contain {z}/{x}/{y}" }, { status: 400 });
  }
  // Dark URL: blank means "keep the schema default" (the CARTO URL), so only shape-check a value.
  const darkUrl = String(b.display?.tile_dark?.url_template ?? "").trim();
  if (darkUrl && !(darkUrl.includes("{z}") && darkUrl.includes("{x}") && darkUrl.includes("{y}"))) {
    return NextResponse.json({ error: "dark tile URL must contain {z}/{x}/{y}" }, { status: 400 });
  }
  // Keep the retention invariant (raw <= decoded) so effectiveConfig stays consistent.
  const rawDays = num(b.retention?.raw_payload_days, 14, 0, 3650);
  const decodedDays = Math.max(rawDays, num(b.retention?.decoded_packet_days, 90, 0, 3650));

  // GA measurement id: allow only the safe id charset so it can be inlined into gtag config.
  const measurementId = String(b.analytics?.measurement_id ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const analytics: Record<string, unknown> = {
    enabled: !!b.analytics?.enabled,
    measurement_id: measurementId,
    client: b.analytics?.client !== false, // default on
    server: !!b.analytics?.server,
  };
  // Only set the api secret when a new one is provided; blank keeps the stored (encrypted) one.
  if (typeof b.analytics?.api_secret === "string" && b.analytics.api_secret !== "") analytics.api_secret = b.analytics.api_secret.trim().slice(0, 100);

  const patch = {
    server: {
      local_timezone: tz,
      public_url: socialUrl(b.display?.public_url).replace(/\/$/, ""), // http(s) only, no trailing slash
      metrics_public: b.privacy?.metrics_public !== false, // default public (historical behavior)
      privacy: {
        fuzz_positions: !!b.privacy?.fuzz_positions,
        fuzz_decimals: num(b.privacy?.fuzz_decimals, 2, 0, 5),
      },
      ui: {
        brand_name: String(b.display?.brand_name ?? "HopWatch").slice(0, 80),
        brand_icon: iconRaw,
        temperature_unit: b.display?.temperature_unit === "c" ? "c" : "f",
        tile_provider: {
          name: String(b.display?.tile?.name ?? "custom").slice(0, 40),
          url_template: tileUrl.slice(0, 400),
          attribution: String(b.display?.tile?.attribution ?? "").slice(0, 300),
          api_key: String(b.display?.tile?.api_key ?? "").slice(0, 200),
        },
        tile_provider_dark: {
          // A blank URL falls back to the schema default (the historical CARTO URL). The 400-char
          // cap comfortably fits a CARTO URL with a `?key=...` query string.
          url_template: (darkUrl || "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png").slice(0, 400),
          attribution: String(b.display?.tile_dark?.attribution ?? "© OpenStreetMap © CARTO").slice(0, 300),
        },
        analytics,
        map_max_age: {
          map: num(b.map_max_age?.map, 0, 0, 525600),
          livemap: num(b.map_max_age?.livemap, 0, 0, 525600),
        },
        map_center: mapCenter(b.map_center),
        social_links: {
          facebook: socialUrl(b.social_links?.facebook),
          discord: socialUrl(b.social_links?.discord),
          website: socialUrl(b.social_links?.website),
        },
      },
    },
    retention: {
      raw_payload_days: rawDays,
      decoded_packet_days: decodedDays,
      telemetry_days: num(b.retention?.telemetry_days, 365, 0, 3650),
      reception_rollup_hour_days: num(b.retention?.reception_rollup_hour_days, 365, 1, 3650),
      live_events_minutes: num(b.retention?.live_events_minutes, 10, 1, 1440),
    },
    features: {
      live_views: !!b.features?.live_views,
      aprs_is_export: !!b.features?.aprs_is_export,
      reference_sheet_pdf: !!b.features?.reference_sheet_pdf,
      ambience_mode: !!b.features?.ambience_mode,
    },
    livemap: {
      enabled: !!b.livemap?.enabled,
      inference_window_hours: num(b.livemap?.inference_window_hours, 24, 1, 720),
      gateway_rings_default: !!b.livemap?.gateway_rings_default,
      audio_default: !!b.livemap?.audio_default,
      max_animations_per_sec: num(b.livemap?.max_animations_per_sec, 50, 1, 1000),
      trail_decay_seconds: num(b.livemap?.trail_decay_seconds, 30, 1, 600),
    },
  };
  try {
    await saveOverrides(patch);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
