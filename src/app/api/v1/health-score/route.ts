import { NextResponse, type NextRequest } from "next/server";
import { getHealthSnapshot } from "../../../../db/queries.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "health");
  if (denied) return denied;
  try {
    return NextResponse.json((await getHealthSnapshot()) ?? { score: null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
