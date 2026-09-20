import { NextResponse, type NextRequest } from "next/server";
import { getRecords } from "../../../../db/queries.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "records");
  if (denied) return denied;
  try {
    return NextResponse.json({ records: await getRecords() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
