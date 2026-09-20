import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { listChannelKeyMeta, upsertChannelKey, deleteChannelKey } from "../../../../../db/settings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-managed channel keys (base64). Used to decrypt/re-decode packets.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  // Never return decrypted PSKs to the browser (Rule 6); report only which names have a key.
  return NextResponse.json({ channel_keys: await listChannelKeyMeta() });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as { name?: string; key?: string } | null;
  if (!b || typeof b.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(b.name)) {
    return NextResponse.json({ error: "name must be 1-64 chars [a-zA-Z0-9_-]" }, { status: 400 });
  }
  if (typeof b.key !== "string" || !isBase64(b.key)) {
    return NextResponse.json({ error: "key must be base64 (e.g. AQ==)" }, { status: 400 });
  }
  await upsertChannelKey(b.name, b.key);
  return NextResponse.json({ ok: true, name: b.name });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  await deleteChannelKey(name);
  return NextResponse.json({ ok: true, name });
}

function isBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  try {
    return Buffer.from(s, "base64").toString("base64") === s;
  } catch {
    return false;
  }
}
