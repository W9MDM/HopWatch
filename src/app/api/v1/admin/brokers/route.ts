import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { loadConfig } from "../../../../../config/load.ts";
import { listBrokers, upsertBroker, deleteBroker, seedIngestConfig, type BrokerInput } from "../../../../../db/settings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-managed MQTT brokers. Edits take effect in the ingest daemon within ~15s.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  try {
    await seedIngestConfig(loadConfig()); // populate from config on first use
  } catch {
    /* config optional */
  }
  const rows = await listBrokers(true);
  // Never leak stored passwords to the browser; report whether one is set.
  const brokers = rows.map((r) => ({
    id: r.id, enabled: !!r.enabled, host: r.host, port: r.port, username: r.username,
    has_password: r.password.length > 0, client_id: r.client_id,
    tls_enabled: !!r.tls_enabled, tls_insecure: !!r.tls_insecure, qos: r.qos,
    topics: safeTopics(r.topics), root_topic: r.root_topic ?? "", log_file: r.log_file ?? "",
  }));
  return NextResponse.json({ brokers });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as (BrokerInput & { keep_password?: boolean }) | null;
  const err = validate(b);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  const input = b as BrokerInput & { keep_password?: boolean };

  // Accept plain region roots (msh/US/IN/NWI) and turn them into subscriptions
  // (msh/US/IN/NWI/#). Anything already containing +/# is left as-is.
  input.topics = input.topics.map(normalizeTopic).filter(Boolean);

  // If editing and the form left the password blank with keep_password, retain the old one.
  if (input.keep_password && (!input.password || input.password.length === 0)) {
    const existing = (await listBrokers(true)).find((x) => x.id === input.id);
    if (existing) input.password = existing.password;
  }
  await upsertBroker(input);
  return NextResponse.json({ ok: true, id: input.id });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteBroker(id);
  return NextResponse.json({ ok: true, id });
}

function validate(b: unknown): string | null {
  if (!b || typeof b !== "object") return "invalid body";
  const x = b as Record<string, unknown>;
  if (typeof x.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(x.id)) return "id must be 1-64 chars [a-zA-Z0-9_-]";
  if (typeof x.host !== "string" || x.host.trim() === "") return "host is required";
  const port = Number(x.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port must be 1-65535";
  if (!Array.isArray(x.topics) || x.topics.length === 0 || !x.topics.every((t) => typeof t === "string" && t.trim() !== ""))
    return "at least one non-empty topic is required";
  if (x.qos !== undefined && ![0, 1, 2].includes(Number(x.qos))) return "qos must be 0, 1, or 2";
  return null;
}

// A bare topic path (no wildcard) becomes a subtree subscription. Meshtastic region
// roots are hierarchical (msh/US/IN/NWI), so a single '+' will not match them.
function normalizeTopic(t: string): string {
  const s = t.trim();
  if (!s) return "";
  if (s.includes("#") || s.includes("+")) return s;
  return s.endsWith("/") ? s + "#" : s + "/#";
}

function safeTopics(t: string): string[] {
  try {
    const a = JSON.parse(t);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}
