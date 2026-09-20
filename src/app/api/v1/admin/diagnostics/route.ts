import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { buildDiagnostics } from "../../../../../db/diagnostics.ts";
import { appVersion } from "../../../../../lib/version.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 24-hour diagnostic bundle. Admin-only: it aggregates traffic across the whole install and
 * includes the TX log, so it is not public even when metrics are.
 *
 * `?download=1` sets a filename so a browser saves it instead of rendering it; the operator can
 * then attach the file to a bug report. The bundle carries only counts, percentages and log
 * lines, never payload bytes or secrets.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  const bundle = await buildDiagnostics(appVersion());
  const body = JSON.stringify(bundle, null, 2);
  const stamp = bundle.generated_at.replace(/[:.]/g, "-");

  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (req.nextUrl.searchParams.get("download") === "1") {
    headers["content-disposition"] = `attachment; filename="hopwatch-diagnostics-${stamp}.json"`;
  }
  return new NextResponse(body, { headers });
}
