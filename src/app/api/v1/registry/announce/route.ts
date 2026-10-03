import { NextResponse, type NextRequest } from "next/server";
import { effectiveConfig } from "../../../../../db/appsettings.ts";
import { upsertInstance } from "../../../../../db/registry.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A stable announcer id: a UUID (what the worker sends) or any similar opaque token.
const ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim().slice(0, 64);
  return (req.headers.get("x-real-ip") ?? "").slice(0, 64);
}

// Public endpoint: receive a heartbeat from another HopWatch instance that opted in to announce
// itself (registry.announce.enabled on its side). Only active when THIS instance is a hub
// (registry.hub.enabled). It is unauthenticated server-to-server, like a public directory ping, so
// it validates and clamps every field, keeps only a real http(s) URL, and dedupes by instance id.
// Minimal identity only; any other fields in the body are ignored.
export async function POST(req: NextRequest) {
  const cfg = await effectiveConfig();
  if (!cfg.registry.hub.enabled) {
    return NextResponse.json({ error: "registry hub not enabled" }, { status: 404 });
  }

  const b = (await req.json().catch(() => null)) as any;
  if (!b || typeof b !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const id = String(b.id ?? "").trim();
  if (!ID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const name = String(b.name ?? "").slice(0, 191);
  let url = String(b.url ?? "").trim().slice(0, 512);
  if (url && !/^https?:\/\//i.test(url)) url = ""; // keep only a real http(s) URL
  const version = String(b.version ?? "").slice(0, 64);

  try {
    await upsertInstance({ instance_id: id, name, url, version, ip: clientIp(req) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
