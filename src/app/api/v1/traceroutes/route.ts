import { NextResponse, type NextRequest } from "next/server";
import { listTraceroutes } from "../../../../db/queries.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "traceroutes");
  if (denied) return denied;
  const limit = req.nextUrl.searchParams.get("limit");
  try {
    return NextResponse.json({ traceroutes: await listTraceroutes(limit ? Number(limit) : 100) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
