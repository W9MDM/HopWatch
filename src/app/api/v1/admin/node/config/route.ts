import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../../db/appsettings.ts";
import { readNodeConfig } from "../../../../../../node/readconfig.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pull a station node's live configuration (MeshMonitor-style). Read-only device query; does
// not transmit over RF and is not gated by the TX arm state. Admin only.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => ({}))) as { host?: string; port?: number; save?: boolean };
  const cfg = await effectiveConfig();
  const host = (b.host ?? cfg.node.host ?? "").trim();
  const port = Number.isFinite(b.port) && b.port ? Math.min(65535, Math.max(1, Math.floor(b.port!))) : cfg.node.port;
  if (!host) return NextResponse.json({ error: "no node host set; enter the node IP/hostname first" }, { status: 400 });

  // Optionally persist the connection so the worker's node transport uses it too.
  if (b.save) {
    try { await saveOverrides({ node: { host: host.slice(0, 255), port } }); } catch { /* non-fatal */ }
  }

  try {
    const snapshot = await readNodeConfig(host, port);
    return NextResponse.json({ ok: true, snapshot });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
