import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveReception, coalesceByPacket, buildRelayResolver, type ResolveCtx, type LiveReception, type LngLat } from "../src/lib/livemap.ts";

const POS: Record<number, LngLat> = {
  0xa1: [-87.6, 41.8], // source
  0xb2: [-87.5, 41.9], // gateway
  0xc3: [-87.55, 41.85], // relay (low byte 0xc3)
};
function ctxWith(resolver?: (b: number) => number | null): ResolveCtx {
  return {
    posOf: (id) => POS[id] ?? null,
    relayResolver: resolver ?? buildRelayResolver([{ id: 0xa1 }, { id: 0xb2 }, { id: 0xc3 }]),
  };
}
function rec(over: Partial<LiveReception> = {}): LiveReception {
  return { packetId: 1, from: 0xa1, gateway: 0xb2, hopStart: 3, hopLimit: 3, relayNode: 0, rssi: -90, snr: 5, port: 3, channel: 0, ...over };
}

test("zero-hop reception is a single direct line", () => {
  const r = resolveReception(rec({ hopStart: 3, hopLimit: 3 }), ctxWith());
  assert.equal(r.direct, true);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0]!.label, "direct");
});

test("2-hop with unresolvable relay byte draws source->gateway only (no invented hop)", () => {
  // relay byte 0x99 matches no known node -> resolver returns null
  const r = resolveReception(rec({ hopStart: 3, hopLimit: 1, relayNode: 0x99 }), ctxWith());
  assert.equal(r.segments.length, 1);
  assert.equal(r.relayId, null);
  assert.equal(r.segments[0]!.label, "source to gateway");
});

test("relay byte resolving to a known positioned node draws source->relay->gateway", () => {
  const r = resolveReception(rec({ hopStart: 3, hopLimit: 1, relayNode: 0xc3 }), ctxWith());
  assert.equal(r.relayId, 0xc3);
  assert.equal(r.segments.length, 2);
  assert.deepEqual(r.segments.map((s) => s.label), ["source to relay", "relay to gateway"]);
});

test("unknown source position draws no line but gateway is still known (for a ring)", () => {
  const r = resolveReception(rec({ from: 0xdead }), ctxWith());
  assert.equal(r.sourcePos, null);
  assert.equal(r.segments.length, 0);
  assert.ok(r.gatewayPos, "gateway position still resolved");
});

test("multi-gateway burst coalesces into one source + three gateways", () => {
  const recs = [
    rec({ packetId: 7, gateway: 0xb2 }),
    rec({ packetId: 7, gateway: 0xc3 }),
    rec({ packetId: 7, gateway: 0xa1 }),
  ];
  const packets = coalesceByPacket(recs, ctxWith());
  assert.equal(packets.length, 1);
  assert.equal(packets[0]!.source, 0xa1);
  assert.equal(packets[0]!.gateways.length, 3);
});

test("relay resolver is null when ambiguous, id when unique", () => {
  const ambiguous = buildRelayResolver([{ id: 0x1111_00c3 }, { id: 0x2222_00c3 }]); // two nodes, same low byte
  assert.equal(ambiguous(0xc3), null);
  const unique = buildRelayResolver([{ id: 0x1234_00c3 }]);
  assert.equal(unique(0xc3), 0x1234_00c3);
});
