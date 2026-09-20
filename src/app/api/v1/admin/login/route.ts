import { NextResponse, type NextRequest } from "next/server";
import { verifyLogin } from "../../../../../auth/users.ts";
import { signSession, SESSION_COOKIE } from "../../../../../auth/session.ts";
import { rateLimit, rateLimitReset } from "../../../../../auth/ratelimit.ts";
import { effectiveConfig } from "../../../../../db/appsettings.ts";
import { sendServerEvent } from "../../../../../lib/analytics.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 5 * 60_000;

export async function POST(req: NextRequest) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!body.username || !body.password) {
    return NextResponse.json({ error: "username and password required" }, { status: 400 });
  }

  // Throttle brute force: per (ip, username) and a wider per-ip cap to stop username spraying.
  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
  const perUser = rateLimit(`login:${ip}:${body.username}`, 10, WINDOW_MS);
  const perIp = rateLimit(`login:${ip}`, 30, WINDOW_MS);
  if (perUser.limited || perIp.limited) {
    const retry = Math.max(perUser.retryAfterS, perIp.retryAfterS);
    return NextResponse.json({ error: "too many attempts, try again later" }, { status: 429, headers: { "Retry-After": String(retry) } });
  }

  try {
    const role = await verifyLogin(body.username, body.password);
    if (!role) return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
    // Successful login clears the throttle for this identity.
    rateLimitReset(`login:${ip}:${body.username}`);
    let ttlHours = 720;
    try { ttlHours = (await effectiveConfig()).server.auth.session_ttl_hours; } catch { /* default */ }
    const { value, maxAge } = signSession(body.username, role, ttlHours * 3600);
    // Server-side GA event (no-op unless server-side analytics is configured).
    void sendServerEvent("admin_login", { role });
    const res = NextResponse.json({ ok: true, role });
    res.cookies.set(SESSION_COOKIE, value, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge,
      secure: process.env.NODE_ENV === "production",
    });
    return res;
  } catch (e) {
    // Do not leak internal (DB/config) detail to an unauthenticated caller.
    console.error(`[login] ${(e as Error).message}`);
    return NextResponse.json({ error: "login unavailable" }, { status: 503 });
  }
}
