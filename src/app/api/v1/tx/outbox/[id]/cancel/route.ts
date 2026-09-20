import { NextResponse, type NextRequest } from "next/server";
import { requireTx } from "../../../../../../../auth/guard.ts";
import { cancelOutbox } from "../../../../../../../db/tx.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cancel a row that has not been sent yet (queued or held). Sent rows cannot be recalled.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireTx(req);
  if (gate instanceof NextResponse) return gate;
  const { id } = await ctx.params;
  const ok = await cancelOutbox(Number(id));
  if (!ok) return NextResponse.json({ error: "not cancellable (already sent or gone)" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
