import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rateAllowed, channelUtilOk, backoffMs, sentState, promote, isConfirmation,
} from "../src/lib/txstate.ts";

test("rate limiter enforces per-minute and per-hour caps", () => {
  const now = 1_000_000;
  const recentMinute = [now - 1000, now - 2000, now - 3000]; // 3 in the last minute
  assert.equal(rateAllowed(recentMinute, now, 3, 30), false, "at the per-minute cap");
  assert.equal(rateAllowed(recentMinute.slice(1), now, 3, 30), true, "under the per-minute cap");
  // 30 sends spread over the last hour but only 1 in the last minute -> per-hour cap blocks.
  const hourFull = Array.from({ length: 30 }, (_, i) => now - i * 100_000);
  assert.equal(rateAllowed(hourFull, now, 3, 30), false, "at the per-hour cap");
});

test("channel-util guard blocks only when util is known and over the cap", () => {
  assert.equal(channelUtilOk(null, 25), true, "unknown util never blocks");
  assert.equal(channelUtilOk(20, 25), true);
  assert.equal(channelUtilOk(25, 25), true, "at the cap is allowed");
  assert.equal(channelUtilOk(30, 25), false, "over the cap holds the queue");
});

test("backoff grows exponentially and caps at 10 minutes", () => {
  assert.equal(backoffMs(1), 5000);
  assert.equal(backoffMs(2), 15000);
  assert.equal(backoffMs(3), 45000);
  assert.equal(backoffMs(20), 600_000);
});

test("sentState reflects dry-run", () => {
  assert.equal(sentState(true), "dry_run");
  assert.equal(sentState(false), "sent");
});

test("promote: heard by a gateway -> heard, routing ack -> acked, never downgrades", () => {
  assert.equal(promote("sent", { gatewayCount: 2, routingAck: false }), "heard");
  assert.equal(promote("sent", { gatewayCount: 3, routingAck: true }), "acked");
  assert.equal(promote("heard", { gatewayCount: 1, routingAck: true }), "acked");
  assert.equal(promote("acked", { gatewayCount: 0, routingAck: false }), "acked", "no downgrade");
  assert.equal(promote("queued", { gatewayCount: 5, routingAck: true }), "queued", "not yet sent");
  assert.equal(promote("cancelled", { gatewayCount: 5, routingAck: true }), "cancelled");
});

test("implicit ACK matches our own packet id + from-node within the window", () => {
  const o = { packetId: 0x1234, fromNode: 0xaabbccdd, sentAtMs: 1_000_000 };
  assert.equal(isConfirmation(o, { packetId: 0x1234, fromNode: 0xaabbccdd, rxAtMs: 1_000_500 }), true);
  // Foreign packet colliding on id but from a different node is NOT a confirmation.
  assert.equal(isConfirmation(o, { packetId: 0x1234, fromNode: 0x99999999, rxAtMs: 1_000_500 }), false);
  // Different packet id is not a confirmation.
  assert.equal(isConfirmation(o, { packetId: 0x9999, fromNode: 0xaabbccdd, rxAtMs: 1_000_500 }), false);
  // Outside the window is not a confirmation.
  assert.equal(isConfirmation(o, { packetId: 0x1234, fromNode: 0xaabbccdd, rxAtMs: 1_000_000 + 16 * 60_000 }), false);
});
