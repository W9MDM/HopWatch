import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { bulkAssign, numIdsByShortNamePattern } from "../../../../../../db/ownednodes.ts";
import { query } from "../../../../../../db/client.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bulk-assign nodes to a user. Admin only. Accepts a short-name REGEXP and/or a list of node ids
// (hex !xxxx or decimal) to CREATE-or-reassign owned records, and/or owned_ids to reassign existing
// rows. Creating a record for an observed node not yet in the registry is the point: it lets an
// admin hand a user a whole fleet (e.g. every RJ## short name) in one go.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as { owner_user_id?: number; owner_group_id?: number; short_name_pattern?: string; node_ids?: string[]; owned_ids?: number[] } | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const isGroup = Number.isInteger(b.owner_group_id);
  if (!isGroup && !Number.isInteger(b.owner_user_id)) return NextResponse.json({ error: "owner_user_id or owner_group_id required" }, { status: 400 });

  const nums = new Map<number, string>(); // node num -> display name
  if (b.short_name_pattern) {
    try { for (const n of await numIdsByShortNamePattern(b.short_name_pattern)) nums.set(n.num, n.name); }
    catch (e) { return NextResponse.json({ error: "bad short-name pattern: " + (e as Error).message }, { status: 400 }); }
  }
  const parsed: number[] = [];
  for (const s of b.node_ids ?? []) {
    const hex = String(s).replace(/^!/, "").trim();
    if (/^[0-9a-fA-F]{1,8}$/.test(hex)) parsed.push(parseInt(hex, 16) >>> 0);
    else if (/^\d+$/.test(String(s).trim())) parsed.push(Number(String(s).trim()) >>> 0);
  }
  if (parsed.length) {
    const rows = await query<{ node_id: number; long_name: string | null; short_name: string | null }>(
      `SELECT node_id, long_name, short_name FROM nodes WHERE node_id IN (${parsed.join(",")})`);
    const nameMap = new Map(rows.map((r) => [r.node_id >>> 0, r.long_name ?? r.short_name ?? null]));
    for (const num of parsed) if (!nums.has(num)) nums.set(num, nameMap.get(num) ?? ("!" + num.toString(16).padStart(8, "0")));
  }
  const nodeNums = [...nums.entries()].map(([num, name]) => ({ num, name }));
  const ownedIds = (b.owned_ids ?? []).filter((x) => Number.isInteger(x));
  if (nodeNums.length === 0 && ownedIds.length === 0) return NextResponse.json({ error: "no nodes matched" }, { status: 400 });

  try {
    const r = await bulkAssign({ ownerUserId: isGroup ? undefined : b.owner_user_id!, ownerGroupId: isGroup ? b.owner_group_id! : undefined, ownedIds, nodeNums });
    return NextResponse.json({ ok: true, ...r, matched: nodeNums.length + ownedIds.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
