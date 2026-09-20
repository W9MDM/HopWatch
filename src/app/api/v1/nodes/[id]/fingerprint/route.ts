import { NextResponse, type NextRequest } from "next/server";
import { getNodeFingerprint } from "../../../../../../db/queries.ts";
import { buildFingerprint } from "../../../../../../lib/fingerprint.ts";
import { requireModule } from "../../../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "nodes");
  if (denied) return denied;
  const { id } = await ctx.params;
  const days = Number(req.nextUrl.searchParams.get("days") ?? 28);
  try {
    const fp = buildFingerprint(await getNodeFingerprint(Number(id), days));
    return NextResponse.json({ node_id: Number(id), days, ...fp });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
