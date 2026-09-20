import { NextResponse, type NextRequest } from "next/server";
import { getSpaceWeather } from "../../../../db/queries.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "propagation");
  if (denied) return denied;
  const hours = req.nextUrl.searchParams.get("hours");
  try {
    return NextResponse.json(await getSpaceWeather(hours ? Number(hours) : 168));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
