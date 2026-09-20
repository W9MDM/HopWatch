import { NextResponse, type NextRequest } from "next/server";
import { resolveAccess } from "../../../../auth/rbac.ts";
import { touchPresence } from "../../../../lib/presence.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Heartbeat for the navbar viewers chip: POST { id } (a random per-tab id) marks this tab
// active and returns the count of tabs active in the last ~90s. Fail-closed like every read:
// callers whose role grants nothing (anonymous with anonymous-read-only off) are denied.
export async function POST(req: NextRequest) {
  const access = await resolveAccess(req);
  if (!access.admin && access.modules.size === 0) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof b?.id === "string" ? b.id : "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  return NextResponse.json({ viewers: touchPresence(id) });
}
