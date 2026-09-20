import { NextResponse, type NextRequest } from "next/server";
import { listPackets, type PacketFilter } from "../../../../db/queries.ts";
import { parseNodeId } from "../../../../meshtastic/types.ts";
import { portName } from "../../../../meshtastic/portnum.ts";
import { toCsv } from "../../../../lib/csv.ts";
import { requireModule } from "../../../../auth/rbac.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/packets: read-only packet list. ?format=csv for export.
export async function GET(req: NextRequest) {
  const denied = await requireModule(req, "packets");
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const filter: PacketFilter = {
    fromNodeId: sp.get("from") ? parseNodeId(sp.get("from")!) : undefined,
    portNum: sp.get("port") ? Number(sp.get("port")) : undefined,
    decodeStatus: sp.get("status") ?? undefined,
    broker: sp.get("broker") ?? undefined,
    channelId: sp.get("channel") ?? undefined,
    fromTime: sp.get("from_time") ?? undefined,
    toTime: sp.get("to_time") ?? undefined,
    limit: sp.get("limit") ? Number(sp.get("limit")) : 100,
    beforeId: sp.get("before_id") ? Number(sp.get("before_id")) : undefined,
  };

  try {
    const rows = await listPackets(filter);
    if (sp.get("format") === "csv") {
      const flat = rows.map((r) => ({ ...r, port_name: portName(r.port_num) }));
      return new NextResponse(toCsv(flat), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="packets.csv"',
        },
      });
    }
    const nextCursor = rows.length ? rows[rows.length - 1]!.id : null;
    return NextResponse.json({ packets: rows, next_cursor: nextCursor });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 503 });
  }
}
