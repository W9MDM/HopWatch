import { NextResponse, type NextRequest } from "next/server";
import { requireTx } from "../../../../../../auth/guard.ts";
import { getOutbox, confirmationsFor } from "../../../../../../db/tx.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireTx(req);
  if (gate instanceof NextResponse) return gate;
  const { id } = await ctx.params;
  const row = await getOutbox(Number(id));
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const confirmations = await confirmationsFor(row.id);
  return NextResponse.json({ outbox: row, confirmations });
}
