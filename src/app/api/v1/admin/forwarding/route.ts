import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { listForwardRuleMeta, updateForwardRuleMeta, upsertForwardRule, deleteForwardRule, distinctChannels, type ForwardRule } from "../../../../../db/settings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_EVENTS = ["text", "new_node"];

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  // Return target counts, never the decrypted target URLs (they embed webhook tokens). Rule 6.
  return NextResponse.json({ rules: await listForwardRuleMeta(), channels: await distinctChannels() });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Partial<ForwardRule> | null;
  if (!b || typeof b.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(b.id)) {
    return NextResponse.json({ error: "id must be 1-64 chars [a-zA-Z0-9_-]" }, { status: 400 });
  }
  const events = Array.isArray(b.events) ? b.events.filter((e) => VALID_EVENTS.includes(e)) : [];
  if (events.length === 0) return NextResponse.json({ error: "select at least one event" }, { status: 400 });
  const channels = Array.isArray(b.channels) ? b.channels.filter((c) => typeof c === "string") : [];
  const targets = Array.isArray(b.targets) ? b.targets.filter((t) => typeof t === "string" && t.trim()) : [];
  const keepTargets = (b as { keep_targets?: boolean }).keep_targets === true;

  // Editing without re-entering targets: keep the stored (encrypted) ones. Only valid for an
  // existing rule; a new rule must supply at least one target.
  if (keepTargets && targets.length === 0) {
    const exists = (await listForwardRuleMeta()).some((r) => r.id === b.id);
    if (!exists) return NextResponse.json({ error: "add at least one target URL" }, { status: 400 });
    await updateForwardRuleMeta({ id: b.id, enabled: b.enabled !== false, events, channels });
    return NextResponse.json({ ok: true, id: b.id });
  }

  if (targets.length === 0) return NextResponse.json({ error: "add at least one target URL" }, { status: 400 });
  await upsertForwardRule({ id: b.id, enabled: b.enabled !== false, events, channels, targets });
  return NextResponse.json({ ok: true, id: b.id });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteForwardRule(id);
  return NextResponse.json({ ok: true, id });
}
