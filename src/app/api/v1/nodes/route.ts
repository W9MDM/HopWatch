import { NextResponse, type NextRequest } from "next/server";
import { listNodes, countNodes, type NodeFilter } from "../../../../db/queries.ts";
import { toCsv } from "../../../../lib/csv.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "nodes");
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const oneOf = <T extends string>(k: string, allowed: readonly T[]): T | undefined => {
    const v = sp.get(k); return v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
  };
  const yesNo = (k: string): boolean | undefined => {
    const v = sp.get(k); return v === "yes" ? true : v === "no" ? false : undefined;
  };
  const filter: NodeFilter = {
    q: sp.get("q") ?? undefined,
    broker: sp.get("broker") ?? undefined,
    channelId: sp.get("channel") ?? undefined,
    role: sp.get("role") ?? undefined,
    hw: sp.get("hw") ?? undefined,
    kind: oneOf("kind", ["gateway", "relay", "node"] as const),
    seenWithin: oneOf("seen", ["1h", "24h", "7d", "30d"] as const),
    sort: oneOf("sort", ["last_seen", "first_seen", "packets", "receptions", "name"] as const),
    hasPosition: yesNo("pos"),
    hasKey: yesNo("key"),
    spoof: sp.get("spoof") === "1" ? true : undefined,
  };
  const limit = sp.get("limit") ? Number(sp.get("limit")) : 300;
  const offset = sp.get("offset") ? Math.max(0, Number(sp.get("offset"))) : 0;
  try {
    const rows = await listNodes({ ...filter, limit, offset });
    if (sp.get("format") === "csv") {
      return new NextResponse(toCsv(rows), {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="nodes.csv"' },
      });
    }
    const total = await countNodes(filter);
    return NextResponse.json({ nodes: rows, total, limit, offset });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
