import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSelfTest, overallSelfTest, type SelfTestSignals } from "../src/lib/selftest.ts";

const base: SelfTestSignals = {
  dbOk: true,
  brokersTotal: 2, brokersConnected: 2,
  lastReceptionAgeSec: 30,
  rollupWatermarkAgeSec: 120,
  healthAgeMin: 3,
  tx: { enabled: false, armed: false, dryRun: true },
  weather: { enabled: false, ageMin: null },
  spaceWeather: { enabled: false, ageMin: null },
};

function byName(s: SelfTestSignals) {
  return new Map(evaluateSelfTest(s).map((c) => [c.name, c]));
}

test("healthy snapshot is all green and TX shows OFF (not a failure)", () => {
  const m = byName(base);
  assert.equal(m.get("Database")!.status, "ok");
  assert.equal(m.get("MQTT brokers")!.status, "ok");
  assert.equal(m.get("Ingest data flow")!.status, "ok");
  assert.equal(m.get("Worker heartbeat")!.status, "ok");
  assert.equal(m.get("Transmit (TX)")!.status, "off");
  assert.equal(overallSelfTest([...m.values()]), "ok");
});

test("some brokers down warns; all down fails", () => {
  assert.equal(byName({ ...base, brokersConnected: 1 }).get("MQTT brokers")!.status, "warn");
  assert.equal(byName({ ...base, brokersConnected: 0 }).get("MQTT brokers")!.status, "fail");
  assert.equal(byName({ ...base, brokersTotal: 0, brokersConnected: 0 }).get("MQTT brokers")!.status, "off");
});

test("stale worker heartbeat fails and drives the overall status", () => {
  const checks = evaluateSelfTest({ ...base, healthAgeMin: 120 });
  assert.equal(checks.find((c) => c.name === "Worker heartbeat")!.status, "fail");
  assert.equal(overallSelfTest(checks), "fail");
});

test("enabled feeds are checked for freshness only when on", () => {
  assert.equal(byName(base).get("Space weather feed"), undefined);
  const m = byName({ ...base, spaceWeather: { enabled: true, ageMin: 500 } });
  assert.equal(m.get("Space weather feed")!.status, "fail");
});
