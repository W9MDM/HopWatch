import { NextResponse, type NextRequest } from "next/server";
import { ghostNodes } from "../../../../db/queries.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "ghosts");
  if (denied) return denied;
  const max = Number(req.nextUrl.searchParams.get("max") ?? 3);
  try {
    return NextResponse.json({ max, ghosts: await ghostNodes(max, 300) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
