import { NextResponse, type NextRequest } from "next/server";
import { gatewayCompare, longestDirectLinks, hopDistribution } from "../../../../db/queries.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Aggregate analytics snapshot: gateway compare, longest direct links, hop distribution.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "analytics");
  if (denied) return denied;
  try {
    const [gateway_compare, longest_links, hop_distribution] = await Promise.all([
      gatewayCompare(),
      longestDirectLinks(50),
      hopDistribution(24),
    ]);
    return NextResponse.json({ gateway_compare, longest_links, hop_distribution });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
