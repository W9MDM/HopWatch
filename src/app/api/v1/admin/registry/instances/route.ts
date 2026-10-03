import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../../auth/guard.ts";
import { setInstanceHidden, deleteInstance } from "../../../../../../db/registry.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Moderate the hub directory: hide/unhide a noisy or bogus entry, or delete one outright.
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as any;
  const id = String(b?.id ?? "").trim();
  const action = String(b?.action ?? "");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  try {
    if (action === "hide") await setInstanceHidden(id, true);
    else if (action === "unhide") await setInstanceHidden(id, false);
    else if (action === "delete") await deleteInstance(id);
    else return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
