import { type NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { effectiveConfig } from "../../../../db/appsettings.ts";
import { getPublicStats, type PublicStats } from "../../../../db/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public read-only aggregate stats for external pollers (Home Assistant, dashboards). No auth, no
// per-node detail, no names/positions/message text/public keys, no broker secrets: the same data
// class the public Prometheus /metrics endpoint already exposes. Gated by a DB-backed toggle
// (api.public_stats) so an admin can disable it; cache + rate limit are settings too (Rule 1).
//
// STABLE CONTRACT: `schema_version` is 1. Fields are only added from here, never renamed or removed,
// so published Home Assistant packages keep working. Bump schema_version only on a breaking change.
const SCHEMA_VERSION = 1;

// One computed snapshot shared by every caller, rebuilt at most once per cache_seconds. Polling can
// never hit the DB more often than that regardless of how many clients poll (single web process).
let cache: { builtAt: number; etag: string; lastModified: string; body: string; bodyPretty: string } | null = null;

// Per-IP fixed-window rate limiter (per process). Basic by design: the data is public and read-only,
// so this only stops one client from hammering past the shared cache.
const hits = new Map<string, { count: number; windowStart: number }>();

function clientIp(req: NextRequest): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return (xff.split(",")[0] ?? "").trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Returns the Retry-After seconds when the caller is over budget this minute, else null. */
function rateLimited(ip: string, perMin: number, now: number): number | null {
  const winMs = 60_000;
  let h = hits.get(ip);
  if (!h || now - h.windowStart >= winMs) { h = { count: 0, windowStart: now }; hits.set(ip, h); }
  h.count++;
  // Bound memory: periodically drop windows that have fully elapsed.
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (now - v.windowStart >= winMs) hits.delete(k);
  }
  if (h.count > perMin) return Math.max(1, Math.ceil((h.windowStart + winMs - now) / 1000));
  return null;
}

export async function GET(req: NextRequest) {
  let cfg;
  try { cfg = await effectiveConfig(); } catch { return NextResponse.json({ error: "unavailable" }, { status: 503 }); }
  const ps = cfg.api.public_stats;
  // Disabled reads as "no such endpoint", so an install that opts out looks like it has no API.
  if (!ps.enabled) return NextResponse.json({ error: "not found" }, { status: 404 });

  const now = Date.now();
  const retry = rateLimited(clientIp(req), ps.rate_limit_per_min, now);
  if (retry !== null) {
    return new NextResponse(JSON.stringify({ error: "rate limited", retry_after: retry }), {
      status: 429,
      headers: { "content-type": "application/json; charset=utf-8", "retry-after": String(retry) },
    });
  }

  if (!cache || now - cache.builtAt >= ps.cache_seconds * 1000) {
    let stats: PublicStats;
    try { stats = await getPublicStats(cfg.server.local_timezone); }
    catch { return NextResponse.json({ error: "unavailable" }, { status: 503 }); }
    const payload = { schema_version: SCHEMA_VERSION, generated_at: new Date(now).toISOString(), ...stats };
    const body = JSON.stringify(payload);
    cache = {
      builtAt: now,
      etag: `"${createHash("sha1").update(body).digest("hex")}"`,
      lastModified: new Date(now).toUTCString(),
      body,
      bodyPretty: JSON.stringify(payload, null, 2),
    };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": `public, max-age=${ps.cache_seconds}`,
    "etag": cache.etag,
    "last-modified": cache.lastModified,
    "x-robots-tag": "noindex",
  };

  // Conditional GET: let a poller skip the body when nothing changed since its last ETag.
  const inm = req.headers.get("if-none-match");
  if (inm && inm === cache.etag) return new NextResponse(null, { status: 304, headers });

  const pretty = req.nextUrl.searchParams.get("pretty");
  const body = pretty === "1" || pretty === "true" ? cache.bodyPretty : cache.body;
  return new NextResponse(body, { status: 200, headers });
}
