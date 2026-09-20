// Self-test: turn a snapshot of subsystem signals into a pass/warn/fail checklist for the
// /health page ("is everything actually working right now"). Pure and testable; the DB reads
// that gather the signals live in queries.ts, and enable-flags come from effectiveConfig.

export type CheckStatus = "ok" | "warn" | "fail" | "off";

export interface SelfTestCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface SelfTestSignals {
  dbOk: boolean; // we successfully read from the DB to build this
  brokersTotal: number;
  brokersConnected: number;
  lastReceptionAgeSec: number | null; // age of the newest reception
  rollupWatermarkAgeSec: number | null; // age of the last folded rollup hour
  healthAgeMin: number | null; // age of the last health-score computation (worker medium loop)
  tx: { enabled: boolean; armed: boolean; dryRun: boolean };
  weather: { enabled: boolean; ageMin: number | null };
  spaceWeather: { enabled: boolean; ageMin: number | null };
}

// Thresholds (seconds / minutes). Generous: a mesh can be legitimately quiet.
const RX_WARN_S = 30 * 60;
const RX_FAIL_S = 3 * 60 * 60;
const ROLLUP_WARN_S = 2 * 60 * 60;
const ROLLUP_FAIL_S = 6 * 60 * 60;
const HEALTH_WARN_MIN = 15;
const HEALTH_FAIL_MIN = 60;
const FEED_WARN_MIN = 90;
const FEED_FAIL_MIN = 6 * 60;

function ageBand(age: number | null, warn: number, fail: number, unit: string): { status: CheckStatus; detail: string } {
  if (age == null) return { status: "warn", detail: "no data yet" };
  const rounded = Math.round(age);
  const shown = `${rounded}${unit} ago`;
  if (age > fail) return { status: "fail", detail: shown };
  if (age > warn) return { status: "warn", detail: shown };
  return { status: "ok", detail: shown };
}

export function evaluateSelfTest(s: SelfTestSignals): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];

  checks.push({ name: "Database", status: s.dbOk ? "ok" : "fail", detail: s.dbOk ? "reachable" : "unreachable" });

  if (s.brokersTotal === 0) {
    checks.push({ name: "MQTT brokers", status: "off", detail: "none configured" });
  } else if (s.brokersConnected === 0) {
    checks.push({ name: "MQTT brokers", status: "fail", detail: `0 / ${s.brokersTotal} connected` });
  } else if (s.brokersConnected < s.brokersTotal) {
    checks.push({ name: "MQTT brokers", status: "warn", detail: `${s.brokersConnected} / ${s.brokersTotal} connected` });
  } else {
    checks.push({ name: "MQTT brokers", status: "ok", detail: `${s.brokersConnected} / ${s.brokersTotal} connected` });
  }

  const rx = ageBand(s.lastReceptionAgeSec, RX_WARN_S, RX_FAIL_S, "s");
  checks.push({ name: "Ingest data flow", status: rx.status, detail: s.lastReceptionAgeSec == null ? "no receptions yet" : `last reception ${Math.round(s.lastReceptionAgeSec / 60)}m ago` });

  const roll = ageBand(s.rollupWatermarkAgeSec, ROLLUP_WARN_S, ROLLUP_FAIL_S, "s");
  checks.push({ name: "Worker rollups", status: roll.status, detail: s.rollupWatermarkAgeSec == null ? "no rollups yet" : `watermark ${Math.round(s.rollupWatermarkAgeSec / 60)}m old` });

  const hb = ageBand(s.healthAgeMin, HEALTH_WARN_MIN, HEALTH_FAIL_MIN, "m");
  checks.push({ name: "Worker heartbeat", status: hb.status, detail: s.healthAgeMin == null ? "no health score yet" : `health computed ${Math.round(s.healthAgeMin)}m ago` });

  if (!s.tx.enabled) {
    checks.push({ name: "Transmit (TX)", status: "off", detail: "disabled (RX only)" });
  } else {
    checks.push({ name: "Transmit (TX)", status: "ok", detail: `enabled, ${s.tx.armed ? (s.tx.dryRun ? "armed (dry-run)" : "armed and live") : "disarmed"}` });
  }

  if (s.weather.enabled) {
    const w = ageBand(s.weather.ageMin, FEED_WARN_MIN, FEED_FAIL_MIN, "m");
    checks.push({ name: "Weather feed", status: w.status, detail: w.detail });
  }
  if (s.spaceWeather.enabled) {
    const w = ageBand(s.spaceWeather.ageMin, FEED_WARN_MIN, FEED_FAIL_MIN, "m");
    checks.push({ name: "Space weather feed", status: w.status, detail: w.detail });
  }

  return checks;
}

/** Worst status across all checks (off is ignored), for a rollup headline. */
export function overallSelfTest(checks: SelfTestCheck[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}
