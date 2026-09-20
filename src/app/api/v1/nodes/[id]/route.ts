import { NextResponse, type NextRequest } from "next/server";
import { getNode, getNodeBiography } from "../../../../../db/queries.ts";
import { requireModule, resolveAccess } from "../../../../../auth/rbac.ts";
import { effectiveConfig } from "../../../../../db/appsettings.ts";
import { fuzzPositions, fuzzNodeCoords, fuzzDecimalsFor, stripNodePosition } from "../../../../../lib/fuzz.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireModule(req, "nodes");
  if (denied) return denied;
  const { id } = await ctx.params;
  const nodeId = Number(id);
  try {
    const row = await getNode(nodeId);
    if (!row) return NextResponse.json({ error: "unknown node" }, { status: 404 });
    const bio = await getNodeBiography(nodeId);
    // `nodes` is in the default anonymous role, so without this an unauthenticated caller could
    // walk the already-public node list and read every node's exact home coordinate plus up to 500
    // exact historical fixes: a full movement track, which is exactly what fuzz_positions exists to
    // prevent, and which the operator's per-node position_ignored flag is supposed to suppress.
    const isAdmin = (await resolveAccess(req)).admin;
    const fuzz = fuzzDecimalsFor(await effectiveConfig(), isAdmin);
    const suppressed = !isAdmin && !!row.position_ignored;
    const node = fuzzNodeCoords(suppressed ? stripNodePosition(row) : row, fuzz);
    // The history is rounded to the same grid, not dropped: that is the documented contract
    // ("coordinates ... are rounded for non-admins"). It IS dropped for a node whose position the
    // operator suppressed, because there the instruction is "do not publish this position".
    const biography = { ...bio, positions: suppressed ? [] : fuzzPositions(bio.positions, fuzz) };
    return NextResponse.json({ node, biography });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
