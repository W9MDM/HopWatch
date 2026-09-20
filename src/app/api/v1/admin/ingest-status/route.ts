import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { query } from "../../../../../db/client.ts";
import { bumpRev } from "../../../../../db/settings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface HealthRow {
  broker_id: string;
  connected: number;
  last_message_at: string | null;
  messages: number;
  malformed: number;
  reconnects: number;
  updated_at: string | null;
}

async function status(): Promise<HealthRow[]> {
  return query<HealthRow>(
    `SELECT broker_id, connected, last_message_at, messages, malformed, reconnects, updated_at
     FROM broker_health ORDER BY broker_id`,
  );
}

// GET: current broker connection status. POST: force the ingest daemon to reload
// brokers/keys on its next poll (a few seconds), then return status. No OS restart.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json({ brokers: await status() });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  await bumpRev();
  return NextResponse.json({ ok: true, reloading: true, brokers: await status() });
}
