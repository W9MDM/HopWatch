import { NextResponse, type NextRequest } from "next/server";
import { requireTx } from "../../../../../auth/guard.ts";
import { listTxLog } from "../../../../../db/tx.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TX debug log for operators without shell access: the worker's send-pipeline trace, newest first.
export async function GET(req: NextRequest) {
  const gate = await requireTx(req);
  if (gate instanceof NextResponse) return gate;
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 150);
  try {
    return NextResponse.json({ log: await listTxLog(limit) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
