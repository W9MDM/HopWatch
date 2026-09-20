import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { importMeshadmin, type ImportSource } from "../../../../../db/importmeshadmin.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Import meshadmin data into the owned-node tables. Admin only. Accepts either a multipart
// upload of a mysqldump .sql file, or JSON describing a live MySQL source.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;

  let source: ImportSource;
  let dryRun = false;
  const ct = req.headers.get("content-type") ?? "";

  try {
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "no .sql file uploaded" }, { status: 400 });
      const sql = await file.text();
      if (!sql.trim()) return NextResponse.json({ error: "uploaded file is empty" }, { status: 400 });
      const meshTable = String(form.get("mesh_table") ?? "nodes");
      dryRun = String(form.get("dry_run") ?? "") === "true";
      source = { kind: "sql", sql, meshTable };
    } else {
      const b = (await req.json().catch(() => null)) as Record<string, any> | null;
      if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });
      dryRun = !!b.dry_run;
      if (b.mode === "sql" || typeof b.sql === "string") {
        if (!b.sql?.trim()) return NextResponse.json({ error: "no SQL provided" }, { status: 400 });
        source = { kind: "sql", sql: String(b.sql), meshTable: b.mesh_table };
      } else {
        if (!b.host || !b.user) return NextResponse.json({ error: "host and user required for a live source" }, { status: 400 });
        source = { kind: "live", host: String(b.host), port: b.port ? Number(b.port) : undefined, user: String(b.user), password: String(b.password ?? ""), adminDb: b.admin_db, meshDb: b.mesh_db, meshTable: b.mesh_table };
      }
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const result = await importMeshadmin(source, dryRun);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
