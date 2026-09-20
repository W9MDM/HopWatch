import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReception,
  feedsDirectRoster,
  isRfReception,
  type ReceptionFacts,
} from "../src/meshtastic/classify.ts";

// A well-formed direct reception baseline; individual tests override fields.
function facts(over: Partial<ReceptionFacts> = {}): ReceptionFacts {
  return {
    gatewayId: 0xaaaa0001,
    fromNodeId: 0xbbbb0002,
    rxRssi: -95,
    rxSnr: 6.5,
    hopStart: 3,
    hopLimit: 3,
    relayNode: 0,
    ...over,
  };
}

test("zero-hop reception with RF metadata is rf_direct and feeds the roster", () => {
  const c = classifyReception(facts({ hopStart: 3, hopLimit: 3 }));
  assert.equal(c.class, "rf_direct");
  assert.equal(c.hopsUsed, 0);
  assert.equal(c.isConfirmedDirect, true);
  assert.equal(feedsDirectRoster(c), true);
  assert.equal(isRfReception(c), true);
});

test("hops_used > 0 is rf_relayed and does NOT feed the roster", () => {
  const c = classifyReception(facts({ hopStart: 3, hopLimit: 1 }));
  assert.equal(c.class, "rf_relayed");
  assert.equal(c.hopsUsed, 2);
  assert.equal(feedsDirectRoster(c), false);
  assert.equal(isRfReception(c), true);
});

test("self-gated (gateway_id == from) is mqtt_self, never direct", () => {
  const c = classifyReception(facts({ gatewayId: 0x1234, fromNodeId: 0x1234 }));
  assert.equal(c.class, "mqtt_self");
  assert.equal(c.isConfirmedDirect, false);
  assert.equal(feedsDirectRoster(c), false);
});

test("no RF metadata is mqtt_injected", () => {
  const c = classifyReception(facts({ rxRssi: null, rxSnr: null }));
  assert.equal(c.class, "mqtt_injected");
  assert.equal(c.hasRfMetadata, false);
  assert.equal(isRfReception(c), false);
});

test("old firmware (no hop_start) with RF and no relay byte is rf_direct_low_conf, NOT rf_direct", () => {
  const c = classifyReception(facts({ hopStart: null, hopLimit: 3, relayNode: 0 }));
  assert.equal(c.class, "rf_direct_low_conf");
  assert.equal(c.isConfirmedDirect, false, "low-confidence must not inflate confirmed direct counts");
  assert.equal(feedsDirectRoster(c), false);
  assert.equal(isRfReception(c), true);
});

test("no hop_start but relay_node present -> rf_relayed", () => {
  const c = classifyReception(facts({ hopStart: null, hopLimit: 3, relayNode: 0x42 }));
  assert.equal(c.class, "rf_relayed");
});

test("no hop_start, relay_node explicitly 0 -> low-confidence direct (0 means none)", () => {
  const c = classifyReception(facts({ hopStart: null, relayNode: 0 }));
  assert.equal(c.class, "rf_direct_low_conf");
});

test("no hop_start, relay_node absent (null) -> low-confidence direct", () => {
  const c = classifyReception(facts({ hopStart: null, relayNode: null }));
  assert.equal(c.class, "rf_direct_low_conf");
});

test("inconsistent header (hop_limit > hop_start) -> unknown", () => {
  const c = classifyReception(facts({ hopStart: 2, hopLimit: 5 }));
  assert.equal(c.class, "unknown");
  assert.equal(c.hopsUsed, -3);
  assert.equal(feedsDirectRoster(c), false);
});

test("present rx_rssi of 0 still counts as RF metadata (suspect, not absent)", () => {
  const c = classifyReception(facts({ rxRssi: 0, rxSnr: null, hopStart: 5, hopLimit: 5 }));
  assert.equal(c.hasRfMetadata, true);
  assert.equal(c.class, "rf_direct");
});

test("self-gated takes precedence even with RF metadata present", () => {
  // A gateway that also originates: gateway_id == from wins over any hop/rssi values.
  const c = classifyReception(facts({ gatewayId: 0x777, fromNodeId: 0x777, hopStart: 3, hopLimit: 3 }));
  assert.equal(c.class, "mqtt_self");
});

test("multi-gateway: same packet, three gateways, each classified independently", () => {
  const from = 0xdead;
  // Gateway A hears it direct.
  const a = classifyReception({
    gatewayId: 0xa1, fromNodeId: from, rxRssi: -80, rxSnr: 9, hopStart: 3, hopLimit: 3, relayNode: 0,
  });
  // Gateway B hears it after 2 relays.
  const b = classifyReception({
    gatewayId: 0xb2, fromNodeId: from, rxRssi: -110, rxSnr: -2, hopStart: 3, hopLimit: 1, relayNode: 0x9,
  });
  // Gateway C is actually the node itself self-gating.
  const c = classifyReception({
    gatewayId: from, fromNodeId: from, rxRssi: null, rxSnr: null, hopStart: 3, hopLimit: 3, relayNode: 0,
  });
  assert.equal(a.class, "rf_direct");
  assert.equal(b.class, "rf_relayed");
  assert.equal(c.class, "mqtt_self");
  // Exactly one of the three feeds the direct roster.
  assert.equal([a, b, c].filter(feedsDirectRoster).length, 1);
});
