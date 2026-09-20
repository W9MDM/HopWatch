import { NextResponse, type NextRequest } from "next/server";
import { requireTx } from "../../../../../auth/guard.ts";
import { effectiveConfig } from "../../../../../db/appsettings.ts";
import { getChannelKeys } from "../../../../../db/settings.ts";
import { enqueueTx } from "../../../../../db/tx.ts";
import { parseNodeId } from "../../../../../meshtastic/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { to, kind: "position" | "telemetry" } queues a want_response request to a node.
export async function POST(req: NextRequest) {
  const gate = await requireTx(req);
  if (gate instanceof NextResponse) return gate;

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const to = b?.to != null ? parseNodeId(String(b.to)) : 0;
  if (!to) return NextResponse.json({ error: "to required" }, { status: 400 });
  const kind = b?.kind === "telemetry" ? "telemetry_req" : b?.kind === "position" ? "position_req" : null;
  if (!kind) return NextResponse.json({ error: "kind must be position or telemetry" }, { status: 400 });

  const cfg = await effectiveConfig();
  if (!cfg.tx.enabled) return NextResponse.json({ error: "tx disabled" }, { status: 409 });

  if (b?.channel != null && b.channel !== "" && !/^[A-Za-z0-9_-]{1,64}$/.test(String(b.channel))) return NextResponse.json({ error: "invalid channel name" }, { status: 400 });
  const keys = await getChannelKeys();
  const channel = b?.channel != null && b.channel !== "" ? String(b.channel) : keys[0]?.name ?? null;
  if (!channel) return NextResponse.json({ error: "no channel available" }, { status: 400 });

  const id = await enqueueTx({
    createdBy: gate.actor, transport: cfg.tx.transport, kind, channelId: channel, toNode: to,
    fromNode: cfg.tx.from_node, hopLimit: cfg.tx.default_hop_limit, wantAck: false,
  });
  return NextResponse.json({ id });
}
