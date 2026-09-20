import { NextResponse, type NextRequest } from "next/server";
import { getMatrix } from "../../../../db/queries.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "matrix");
  if (denied) return denied;
  const limit = req.nextUrl.searchParams.get("nodes");
  try {
    return NextResponse.json(await getMatrix(limit ? Number(limit) : 60));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
