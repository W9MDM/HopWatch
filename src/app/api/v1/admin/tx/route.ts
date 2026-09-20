import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const num = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const cfg = await effectiveConfig();
  return NextResponse.json({ tx: cfg.tx, node: cfg.node });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const fromNode = num(b.from_node, 0, 0, 0xffffffff);
  // Cannot arm without a transmit identity.
  if (b.armed && fromNode <= 0) return NextResponse.json({ error: "set tx.from_node before arming" }, { status: 400 });

  const maxHop = num(b.max_hop_limit, 3, 0, 7);
  const patch = {
    tx: {
      enabled: !!b.enabled,
      armed: !!b.armed,
      dry_run: b.dry_run === undefined ? true : !!b.dry_run,
      transport: b.transport === "node" ? "node" : "mqtt",
      broker_id: String(b.broker_id ?? "").slice(0, 64),
      default_hop_limit: Math.min(num(b.default_hop_limit, 3, 0, 7), maxHop),
      max_hop_limit: maxHop,
      rate_limit: {
        per_minute: num(b.rate_limit?.per_minute, 3, 1, 60),
        per_hour: num(b.rate_limit?.per_hour, 30, 1, 1000),
      },
      max_channel_util: num(b.max_channel_util, 25, 0, 100),
      from_node: fromNode,
      node_long_name: String(b.node_long_name ?? "HopWatch").slice(0, 40),
      node_short_name: String(b.node_short_name ?? "HOPW").slice(0, 8),
      ok_to_mqtt: b.ok_to_mqtt === undefined ? true : !!b.ok_to_mqtt,
      announce_interval_s: num(b.announce_interval_s, 0, 0, 86400),
      canned_messages: (Array.isArray(b.canned_messages) ? b.canned_messages : [])
        .map((x: unknown) => String(x ?? "").slice(0, 220)).filter(Boolean).slice(0, 30),
      // auto_responder, auto_traceroute, and traceroute_cooldown_s are managed on their own tabs
      // (dedicated endpoints that patch just those slices), so this route leaves them untouched.
    },
  };
  // Station-node connection (used for TX when transport = "node", and for RF receive ingest
  // when rx_enabled). Host may be an IP or hostname.
  const nm = b.node?.nodedb_maint;
  const nodePatch = b.node
    ? { node: {
        host: String(b.node.host ?? "").trim().slice(0, 255),
        port: num(b.node.port, 4403, 1, 65535),
        rx_enabled: !!b.node.rx_enabled,
        ...(nm ? { nodedb_maint: {
          enabled: !!nm.enabled,
          interval_hours: num(nm.interval_hours, 24, 1, 24 * 30),
          stale_days: num(nm.stale_days, 7, 1, 365),
          favorite_repeaters: nm.favorite_repeaters !== false,
        } } : {}),
      } }
    : {};

  try {
    await saveOverrides({ ...patch, ...nodePatch });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
