import { test } from "node:test";
import assert from "node:assert/strict";
import { DedupCache, fidelityRank, RANK_JSON, RANK_PROTOBUF, RANK_RF } from "../src/ingest/dedup.ts";
import { dedupBucket, dedupLookupRange } from "../src/lib/time.ts";

// ---------------------------------------------------------------------------
// Rolling packet dedup across a bucket boundary.
//
// first_seen_at is a BUCKET START, so it sits up to one window before its own rx_time, and the
// other gateway's rx_time may itself be up to a window earlier. The lookup's lower bound was
// rx - w, one window too tight, so a straddling pair missed whenever the earlier-bucket copy was
// ingested first and one logical packet became two rows.
// ---------------------------------------------------------------------------

const W = 300; // seconds; the schema default

/** first_seen_at as the pipeline computes it for a given rx time. */
function firstSeenAtMs(rxMs: number): number {
  return dedupBucket(new Date(rxMs), W) * W * 1000;
}
function inRange(candidateMs: number, rxMs: number): boolean {
  const r = dedupLookupRange(new Date(rxMs), W);
  return candidateMs >= r.from.getTime() && candidateMs <= r.to.getTime();
}

test("a boundary-straddling pair resolves to one packet in BOTH ingest orders", () => {
  const boundary = 1_800_000_000_000; // exactly on a 300s bucket edge
  const rxA = boundary - 1_000; // just before: bucket k-1
  const rxB = boundary + 1_000; // just after:  bucket k
  assert.notEqual(dedupBucket(new Date(rxA), W), dedupBucket(new Date(rxB), W), "must straddle");

  // A first, then B looks A up. This is the case that used to miss.
  assert.ok(inRange(firstSeenAtMs(rxA), rxB), "B must find A's bucket start");
  // B first, then A looks B up.
  assert.ok(inRange(firstSeenAtMs(rxB), rxA), "A must find B's bucket start");
});

test("the lookup reaches a full two windows back, and no further than one forward", () => {
  const rx = 1_800_000_000_000;
  const r = dedupLookupRange(new Date(rx), W);
  assert.equal(rx - r.from.getTime(), 2 * W * 1000, "lower bound is rx - 2w");
  assert.equal(r.to.getTime() - rx, W * 1000, "upper bound is rx + w");
});

test("copies further apart than the window are still treated as distinct packets", () => {
  // Dedup must not become unbounded: a reused packet id an hour later is a different packet.
  const rx = 1_800_000_000_000;
  assert.equal(inRange(firstSeenAtMs(rx - 3600_000), rx), false);
});

// ---------------------------------------------------------------------------
// Fidelity ranking. Both the protobuf and JSON publication of one packet reach the same dedup
// key, and the JSON decode path is synchronous while protobuf awaits, so JSON reliably won and
// the richer copy was discarded (no ok_to_mqtt, no relay_node, no traceroute parse).
// ---------------------------------------------------------------------------

test("a protobuf copy supersedes a JSON copy of the same packet exactly once", () => {
  const c = new DedupCache(60_000);
  const k = "1:2:3";
  assert.equal(c.seen(k, 1000, RANK_JSON), false, "first JSON copy is new");
  assert.equal(c.seen(k, 1001, RANK_PROTOBUF), false, "protobuf supersedes it");
  assert.equal(c.seen(k, 1002, RANK_PROTOBUF), true, "a second protobuf copy is a duplicate");
  assert.equal(c.seen(k, 1003, RANK_JSON), true, "a later JSON copy cannot re-win");
});

test("same-format repeat deliveries still collapse", () => {
  const c = new DedupCache(60_000);
  assert.equal(c.seen("a", 0, RANK_JSON), false);
  assert.equal(c.seen("a", 1, RANK_JSON), true);
  const d = new DedupCache(60_000);
  assert.equal(d.seen("b", 0, RANK_PROTOBUF), false);
  assert.equal(d.seen("b", 1, RANK_PROTOBUF), true);
});

test("RF outranks everything, so the node's own MQTT echo stays suppressed", () => {
  const c = new DedupCache(60_000);
  const k = "9:9:9";
  // The RF path claims the shared key to suppress the node's later MQTT uplink of the same
  // reception. A protobuf echo must NOT be able to supersede that claim.
  assert.equal(c.seen(k, 1000, RANK_RF), false);
  assert.equal(c.seen(k, 1001, RANK_PROTOBUF), true, "MQTT echo must stay suppressed");
  assert.equal(c.seen(k, 1002, RANK_JSON), true);
});

test("a claim still expires with the TTL", () => {
  const c = new DedupCache(1000);
  assert.equal(c.seen("k", 0, RANK_PROTOBUF), false);
  assert.equal(c.seen("k", 500, RANK_PROTOBUF), true, "inside TTL");
  assert.equal(c.seen("k", 2000, RANK_PROTOBUF), false, "past TTL: new packet");
});

test("fidelityRank maps the payload format to the documented order", () => {
  assert.equal(fidelityRank(true), RANK_JSON);
  assert.equal(fidelityRank(false), RANK_PROTOBUF);
  assert.ok(RANK_JSON < RANK_PROTOBUF && RANK_PROTOBUF < RANK_RF);
});

test("the default rank keeps the old two-argument behaviour for other callers", () => {
  // The bridge loop-guard cache calls seen(key, now) with no rank.
  const c = new DedupCache(60_000);
  assert.equal(c.seen("x", 0), false);
  assert.equal(c.seen("x", 1), true);
});
