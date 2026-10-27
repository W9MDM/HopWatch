import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";
import { listBrokers, distinctChannels } from "../../../../../db/settings.ts";
import { listFeedLog } from "../../../../../db/queries.ts";
import { effectiveTopicRoot } from "../../../../../meshtastic/topic.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function brokerRoots(brokers: Awaited<ReturnType<typeof listBrokers>>) {
  return brokers.map((b) => {
    let topics: string[] = [];
    try { const a = JSON.parse(b.topics); if (Array.isArray(a)) topics = a.map(String); } catch { /* ignore */ }
    const r = effectiveTopicRoot(b.root_topic, topics);
    return { id: b.id, host: b.host, root: r.root, rootSource: r.source };
  });
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const [cfg, brokers, channels, log] = await Promise.all([effectiveConfig(), listBrokers(), distinctChannels(), listFeedLog(100)]);
  return NextResponse.json({
    feed: cfg.feed,
    brokers: brokerRoots(brokers),
    channels,
    log,
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const channels = Array.isArray(b.channels) ? [...new Set(b.channels.map((x) => String(x).slice(0, 64)).filter(Boolean))] : [];
  const suffix = String(b.topic_suffix ?? "hopwatch/v1/text").replace(/^\/+|\/+$/g, "").slice(0, 200) || "hopwatch/v1/text";
  const patch = {
    feed: {
      enabled: !!b.enabled,
      armed: !!b.armed,
      broker_id: String(b.broker_id ?? "").slice(0, 64),
      topic_suffix: suffix,
      require_ok_to_mqtt: b.require_ok_to_mqtt !== false, // keep true by default
      public_only: b.public_only !== false, // keep true by default
      all_regions: !!b.all_regions, // false by default: region-scoped to the publish broker
      include_reactions: b.include_reactions !== false, // keep true by default
      channels,
      max_text_chars: Math.min(512, Math.max(1, Number(b.max_text_chars) || 240)),
    },
  };
  try {
    await saveOverrides(patch);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
