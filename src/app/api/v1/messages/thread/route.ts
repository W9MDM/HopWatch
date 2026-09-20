import { NextResponse, type NextRequest } from "next/server";
import { requireModule } from "../../../../../auth/rbac.ts";
import { listTextMessages } from "../../../../../db/queries.ts";
import { txThreadMessages } from "../../../../../db/tx.ts";
import { formatNodeId } from "../../../../../meshtastic/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ms = (s: string) => new Date(s.replace(" ", "T") + "Z").getTime();

export interface ChatItem {
  key: string; timeMs: number; time: string; origin: "rx" | "tx";
  fromNodeId: number | null; fromName: string; channel: string | null; body: string;
  toNode?: number | null; state?: string;
}

// A single channel's message thread: observed (RX) text merged with HopWatch's own sent/queued
// rows (TX), newest first. TX rows carry their outbox state so the chat can show ack progress.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "messages");
  if (denied) return denied;
  const channel = req.nextUrl.searchParams.get("channel") || undefined;
  if (channel && !/^[A-Za-z0-9_-]{1,64}$/.test(channel)) return NextResponse.json({ error: "invalid channel" }, { status: 400 });
  try {
    const [rx, tx] = await Promise.all([
      listTextMessages(200, channel),
      txThreadMessages(200, channel),
    ]);
    const items: ChatItem[] = [
      // Channel conversation only: overheard directed messages (DMs between other nodes)
      // are not part of the channel thread, exactly as a Meshtastic client would not show
      // them. HopWatch's own DMs still appear via the TX rows below (labeled with to_node).
      ...rx.filter((m) => m.to_node_id == null).map((m) => ({
        key: `rx${m.id}`, timeMs: ms(m.observed_at), time: m.observed_at, origin: "rx" as const,
        fromNodeId: m.from_node_id, fromName: m.from_name ?? formatNodeId(m.from_node_id), channel: m.channel_id, body: m.body,
      })),
      ...tx.map((t) => ({
        key: `tx${t.id}`, timeMs: ms(t.sent_at ?? t.created_at), time: t.sent_at ?? t.created_at, origin: "tx" as const,
        fromNodeId: null, fromName: "HopWatch", channel: t.channel_id, body: t.payload_text ?? "", toNode: t.to_node, state: t.state,
      })),
    ].sort((a, b) => b.timeMs - a.timeMs).slice(0, 300);
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
