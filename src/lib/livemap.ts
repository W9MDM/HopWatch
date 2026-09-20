// Live-map path honesty (spec: hard requirement). Pure functions that decide which
// line segments a reception is ALLOWED to draw, given known positions. The map must
// never animate a route the data does not support:
//   - observed segments only: source -> [resolved relay] -> gateway
//   - a relay segment is drawn only when the relay_node byte resolves to a single
//     known-positioned node (otherwise fall back to source -> gateway, no invented hop)
//   - if an endpoint has no position, that line is not drawn (the endpoint still pulses)
//   - zero-hop (hop_start == hop_limit) is a single direct line

export type LngLat = [number, number];

export interface LiveReception {
  packetId: number;
  from: number;
  gateway: number;
  hopStart: number | null;
  hopLimit: number | null;
  relayNode: number | null;
  rssi: number | null;
  snr: number | null;
  port: number | null;
  channel: number | null;
}

export interface ResolveCtx {
  posOf: (nodeId: number) => LngLat | null;
  relayResolver: (byte: number) => number | null;
}

export interface Segment {
  from: LngLat;
  to: LngLat;
  observed: boolean;
  label: string;
}

export interface ResolvedReception {
  packetId: number;
  source: number;
  sourcePos: LngLat | null;
  gatewayId: number;
  gatewayPos: LngLat | null;
  relayId: number | null;
  segments: Segment[];
  direct: boolean;
}

export function resolveReception(rec: LiveReception, ctx: ResolveCtx): ResolvedReception {
  const sourcePos = ctx.posOf(rec.from);
  const gatewayPos = ctx.posOf(rec.gateway);
  const direct = rec.hopStart != null && rec.hopLimit != null && rec.hopStart === rec.hopLimit;

  let relayId: number | null = null;
  let relayPos: LngLat | null = null;
  if (rec.relayNode && rec.relayNode !== 0) {
    relayId = ctx.relayResolver(rec.relayNode);
    if (relayId != null && relayId !== rec.from && relayId !== rec.gateway) relayPos = ctx.posOf(relayId);
    else relayId = relayId === rec.from || relayId === rec.gateway ? null : relayId;
  }

  const segments: Segment[] = [];
  if (sourcePos && gatewayPos) {
    if (relayId != null && relayPos) {
      segments.push({ from: sourcePos, to: relayPos, observed: true, label: "source to relay" });
      segments.push({ from: relayPos, to: gatewayPos, observed: true, label: "relay to gateway" });
    } else {
      segments.push({ from: sourcePos, to: gatewayPos, observed: true, label: direct ? "direct" : "source to gateway" });
    }
  }

  return { packetId: rec.packetId, source: rec.from, sourcePos, gatewayId: rec.gateway, gatewayPos, relayId: relayPos ? relayId : null, segments, direct };
}

export interface PacketAnim {
  packetId: number;
  source: number;
  sourcePos: LngLat | null;
  direct: boolean;
  gateways: { gatewayId: number; gatewayPos: LngLat | null; segments: Segment[]; relayId: number | null }[];
}

// Coalesce receptions of the SAME packet (multi-gateway burst) into one source pulse
// plus one entry per receiving gateway. This is the payoff of the receptions model:
// N gateways -> N rings, not N packets.
export function coalesceByPacket(recs: LiveReception[], ctx: ResolveCtx): PacketAnim[] {
  const groups = new Map<number, LiveReception[]>();
  for (const r of recs) {
    (groups.get(r.packetId) ?? groups.set(r.packetId, []).get(r.packetId)!).push(r);
  }
  const out: PacketAnim[] = [];
  for (const [packetId, group] of groups) {
    const first = group[0]!;
    const sourcePos = ctx.posOf(first.from);
    const gateways = group.map((r) => {
      const res = resolveReception(r, ctx);
      return { gatewayId: res.gatewayId, gatewayPos: res.gatewayPos, segments: res.segments, relayId: res.relayId };
    });
    out.push({ packetId, source: first.from, sourcePos, direct: group.some((r) => r.hopStart != null && r.hopStart === r.hopLimit), gateways });
  }
  return out;
}

// Resolve a relay_node byte to a single positioned node (the last byte of a node id).
// Ambiguous (multiple candidates) -> null, so we never guess.
export function buildRelayResolver(nodes: { id: number }[]): (byte: number) => number | null {
  const byByte = new Map<number, number[]>();
  for (const n of nodes) {
    const b = n.id & 0xff;
    (byByte.get(b) ?? byByte.set(b, []).get(b)!).push(n.id);
  }
  return (byte: number) => {
    const c = byByte.get(byte & 0xff);
    return c && c.length === 1 ? c[0]! : null;
  };
}
