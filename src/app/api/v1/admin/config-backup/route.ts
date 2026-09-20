import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { exportConfig, importConfig, type ConfigBackup } from "../../../../../db/configbackup.ts";
import { appVersion } from "../../../../../lib/version.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Export the full HopWatch configuration (overrides + brokers + channel keys + forward rules) as a
// downloadable JSON file. Secrets are exported as ciphertext, so a restore needs the same master
// key. Admin only.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  try {
    const backup = await exportConfig(appVersion(), new Date().toISOString());
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new NextResponse(JSON.stringify(backup, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="hopwatch-config-${stamp}.json"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// Restore configuration from a backup file. Destructive: replaces settings, brokers, channel keys
// and forward rules. Admin only. Ingest/worker hot-reload within ~5s.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  try {
    const body = (await req.json().catch(() => null)) as ConfigBackup | null;
    if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    const result = await importConfig(body);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
