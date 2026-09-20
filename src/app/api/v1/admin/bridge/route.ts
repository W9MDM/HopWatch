import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";
import { listBrokers, distinctChannels } from "../../../../../db/settings.ts";
import { listBridgeLog } from "../../../../../db/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const [cfg, brokers, channels, log] = await Promise.all([effectiveConfig(), listBrokers(), distinctChannels(), listBridgeLog(100)]);
  return NextResponse.json({
    bridge: cfg.bridge,
    brokers: brokers.map((b) => ({ id: b.id, host: b.host })),
    channels,
    log,
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const localId = String(b.local_broker_id ?? "").slice(0, 64);
  const peers = Array.isArray(b.peer_broker_ids)
    ? b.peer_broker_ids.map((x) => String(x).slice(0, 64)).filter((x) => x && x !== localId)
    : [];
  const direction = b.direction === "out" || b.direction === "in" ? b.direction : "both";
  const channels = Array.isArray(b.channels) ? [...new Set(b.channels.map((x) => String(x).slice(0, 64)).filter(Boolean))] : [];
  const patch = {
    bridge: {
      enabled: !!b.enabled,
      armed: !!b.armed,
      text_only: b.text_only !== false, // keep true by default
      require_ok_to_mqtt: b.require_ok_to_mqtt !== false, // keep true by default
      direction,
      channels,
      local_broker_id: localId,
      peer_broker_ids: [...new Set(peers)],
      rf_to_mqtt: !!b.rf_to_mqtt,
      mqtt_to_rf: !!b.mqtt_to_rf,
      patch_hold_seconds: Math.min(600, Math.max(3, Number(b.patch_hold_seconds) || 20)),
    },
  };
  try {
    await saveOverrides(patch);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
