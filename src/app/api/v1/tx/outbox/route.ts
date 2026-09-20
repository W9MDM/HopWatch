import { NextResponse, type NextRequest } from "next/server";
import { requireTx } from "../../../../../auth/guard.ts";
import { listOutbox } from "../../../../../db/tx.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireTx(req);
  if (gate instanceof NextResponse) return gate;
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
  return NextResponse.json({ outbox: await listOutbox(limit) });
}
