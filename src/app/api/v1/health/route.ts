import { NextResponse, type NextRequest } from "next/server";
import { getHealth } from "../../../../db/queries.ts";
import { versionInfo } from "../../../../lib/version.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Broker connection state + ingest lag surfaced for the health page and monitoring.
//
// Module-gated on "health", matching the /health page (src/app/health/page.tsx) and the README's
// description of this route. It previously took no request at all, so it could not authenticate:
// broker hostnames, per-broker connection state and ingest lag were world-readable even on an
// install with server.auth.anonymous_read_only turned off. requireModule fails closed and still
// allows anonymous access when the anonymous role grants the health module, so a public dashboard
// keeps working while a locked-down install stops leaking its topology.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "health");
  if (denied) return denied;
  try {
    const health = await getHealth();
    const anyConnected = health.brokers.some((b) => b.connected);
    return NextResponse.json({ status: anyConnected ? "ok" : "degraded", version: versionInfo(), ...health });
  } catch (e) {
    console.error(`[health] ${(e as Error).message}`);
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
