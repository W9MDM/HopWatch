import { NextResponse, type NextRequest } from "next/server";
import { requireTx } from "../../../../../auth/guard.ts";
import { effectiveConfig } from "../../../../../db/appsettings.ts";
import { getChannelKeys } from "../../../../../db/settings.ts";
import { enqueueTx } from "../../../../../db/tx.ts";
import { parseNodeId } from "../../../../../meshtastic/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { channel, text } for channel broadcast, or { to, text } for a DM. Queues into the
// outbox; the worker enforces arm state, rate limits, and the rest. Returns the outbox id.
export async function POST(req: NextRequest) {
  const gate = await requireTx(req);
  if (gate instanceof NextResponse) return gate;

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const text = String(b.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  if (Buffer.byteLength(text, "utf8") > 228) return NextResponse.json({ error: "text too long (max 228 bytes)" }, { status: 400 });

  const cfg = await effectiveConfig();
  if (!cfg.tx.enabled) return NextResponse.json({ error: "tx disabled" }, { status: 409 });

  // parseNodeId returns 0 for anything unparseable, and `0 != null` is true, so a junk or zero
  // `to` used to become a real DM addressed to node 0: a transmission that spends airtime and a
  // rate-limit slot, is attributed to the caller, and can never be delivered or acked. Node 0 is
  // not a valid Meshtastic address, so reject it outright (matching tx/request and tx/traceroute,
  // which already guard with `if (!to)`). Omitting `to` entirely still means a channel broadcast.
  let to: number | null = null;
  if (b.to != null && b.to !== "") {
    const parsed = parseNodeId(String(b.to));
    if (!parsed) return NextResponse.json({ error: "invalid to: not a node id" }, { status: 400 });
    to = parsed;
  }
  const keys = await getChannelKeys();
  let channel = b.channel != null && b.channel !== "" ? String(b.channel) : null;
  if (channel && !/^[A-Za-z0-9_-]{1,64}$/.test(channel)) return NextResponse.json({ error: "invalid channel name" }, { status: 400 });
  if (!channel && to != null && keys[0]) channel = keys[0].name;
  if (!channel) return NextResponse.json({ error: "channel required" }, { status: 400 });

  const id = await enqueueTx({
    createdBy: gate.actor,
    transport: cfg.tx.transport,
    kind: to != null ? "dm" : "text",
    channelId: channel,
    toNode: to,
    fromNode: cfg.tx.from_node,
    payloadText: text,
    hopLimit: cfg.tx.default_hop_limit,
    wantAck: to != null,
  });
  return NextResponse.json({ id });
}
