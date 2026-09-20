import { NextResponse, type NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "../../../../auth/session.ts";
import { requireModule } from "../../../../auth/rbac.ts";
import { getUserIdByUsername } from "../../../../auth/users.ts";
import { getUserNode, saveUserNode, listWatchlist } from "../../../../db/watchlist.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function userId(req: NextRequest): Promise<number | null> {
  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  return getUserIdByUsername(session.sub);
}

export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "watchlist");
  if (denied) return denied;
  const uid = await userId(req);
  if (!uid) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const nodeParam = new URL(req.url).searchParams.get("node_id");
  if (nodeParam) {
    const n = Number(nodeParam);
    if (!Number.isFinite(n)) return NextResponse.json({ error: "bad node_id" }, { status: 400 });
    return NextResponse.json({ node: await getUserNode(uid, n >>> 0) });
  }
  return NextResponse.json({ watchlist: await listWatchlist(uid) });
}

export async function POST(req: NextRequest) {
  const denied = await requireModule(req, "watchlist");
  if (denied) return denied;
  const uid = await userId(req);
  if (!uid) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  const n = Number(b?.node_id);
  if (!b || !Number.isFinite(n)) return NextResponse.json({ error: "node_id required" }, { status: 400 });
  await saveUserNode(uid, n >>> 0, {
    favorite: typeof b.favorite === "boolean" ? b.favorite : undefined,
    note: typeof b.note === "string" ? b.note : undefined,
    tags: Array.isArray(b.tags) ? b.tags.map((t: unknown) => String(t)) : undefined,
    alert_offline: typeof b.alert_offline === "boolean" ? b.alert_offline : undefined,
  });
  return NextResponse.json({ ok: true, node: await getUserNode(uid, n >>> 0) });
}
