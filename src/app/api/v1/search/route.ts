import { NextResponse, type NextRequest } from "next/server";
import { listNodes } from "../../../../db/queries.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live entity search for the command palette. Matches nodes by name, short name, or hex id.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "nodes");
  if (denied) return denied;
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 1) return NextResponse.json({ nodes: [] });
  try {
    const rows = await listNodes({ q, limit: 12 });
    return NextResponse.json({
      nodes: rows.map((r) => ({ id: r.node_id, name: r.long_name, short: r.short_name, role: r.role, is_gateway: r.is_gateway })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
