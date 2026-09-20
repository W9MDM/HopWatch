// HopWatch worker. Separate process. Runs rollups, roster materialization, and
// retention on timers. Communicates with ingest/web only via MySQL.
import { effectiveConfig } from "../db/appsettings.ts";
import { closePool } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { runHourlyRollups, runDailyRollups, refoldRecentHours, materializeDirectRoster } from "./rollups.ts";
import { runRetention } from "./retention.ts";
import { evaluateAlerts } from "./alerts.ts";
import { maybeRunDigest } from "./digest.ts";
import { updateSpamScores, applyConfigMuteSeed } from "./spam.ts";
import { computeHealthScore } from "./health.ts";
import { updateRecords } from "./records.ts";
import { updateBaselines, detectPropagation } from "./tropo.ts";
import { ingestWeather } from "./weather.ts";
import { ingestSpaceWeather } from "./spaceweather.ts";
import { computeLinkBudgets } from "./linkbudget.ts";
import { updateRelays, detectFlapping, detectConflicts } from "./integrity.ts";
import { computeBatteryForecasts } from "./battery.ts";
import { runForwarding } from "./forwarding.ts";
import { estimatePositions } from "./position.ts";
import { runTxOutbox, maybeAnnounce, closeBrokerTransports } from "./tx.ts";
import { trimTxLog } from "../db/tx.ts";
import { installRestartWatcher } from "../lib/servicecontrol.ts";
import { failInterruptedSends } from "../db/tx.ts";
import { runNodeDbMaint } from "./nodedbmaint.ts";

// A setInterval whose async body never overlaps itself: if the previous run is still in flight when
// the timer fires, that tick is skipped. Without this, a slow tick (e.g. a multi-second node TX
// handshake) overlaps the next and the same work runs twice.
/**
 * setInterval that never runs its body concurrently with itself. Returns the timer plus a `kick`
 * that runs the body once THROUGH the same guard, so the startup kick cannot overlap the first
 * tick. Calling the job function directly at startup bypassed the guard entirely, and the hourly
 * fold does read-modify-write on the rollup watermark, so two overlapping runs folded the same hour
 * twice and could leave the watermark behind the work already done.
 */
function guardedInterval(ms: number, fn: () => Promise<void>): { timer: NodeJS.Timeout; kick: () => void } {
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    void Promise.resolve(fn()).finally(() => { busy = false; });
  };
  return { timer: setInterval(run, ms), kick: run };
}
import { runMessagePatch } from "./patch.ts";
import { runAutomations } from "./automations.ts";
import { runAutoResponder, runWelcome } from "./autoresponder.ts";
import { runSpamNudge } from "./spamnudge.ts";
import { runAdminScanner } from "./adminscan.ts";
import { runWeatherAlerts } from "./weatheralerts.ts";
import { trimAlertsSent } from "../db/weatheralerts.ts";
import { runAutoTraceroute } from "./traceroute.ts";
import { MqttTxTransport } from "../tx/transport.ts";
import { NodeTxTransport } from "../node/transport.ts";

async function safe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[worker] ${label} failed: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log("[worker] starting");
  await runMigrations();
  installRestartWatcher("worker");

  // Fail any outbox row left mid-send by a previous crash before draining resumes, so a claimed
  // row is never blindly re-transmitted on restart.
  await safe("tx-reconcile", async () => {
    const n = await failInterruptedSends();
    if (n) console.log(`[worker] reconciled ${n} interrupted send(s) to failed`);
  });

  // Ensure partitions exist before anything writes at the boundary.
  await safe("retention(initial)", runRetention);
  // Mute seed reads effectiveConfig (file + admin overrides), not loadConfig (Rule 1).
  await safe("mute-seed", async () => applyConfigMuteSeed(await effectiveConfig()));

  // Fast loop: fold hourly rollups + refresh the direct-heard roster + alerts every 60s.
  const fastLoop = guardedInterval(60_000, () => safe("fast", async () => {
    await safe("hourly-rollups", async () => {
      const n = await runHourlyRollups();
      if (n) console.log(`[worker] folded ${n} hour(s)`);
    });
    await safe("direct-roster", materializeDirectRoster);
    await safe("alerts", async () => {
      const fired = await evaluateAlerts(await effectiveConfig());
      if (fired) console.log(`[worker] fired ${fired} alert(s)`);
    });
    await safe("forwarding", async () => {
      const n = await runForwarding();
      if (n) console.log(`[worker] forwarded ${n} message(s)`);
    });
  }));

  // Medium loop: RF baselines, propagation detection, health, records every 5 min.
  const mediumLoop = guardedInterval(5 * 60_000, () => safe("medium", async () => {
      const c = await effectiveConfig();
      await safe("baselines", () => updateBaselines(c));
      await safe("propagation", async () => {
        const n = await detectPropagation(c);
        if (n) console.log(`[worker] logged ${n} propagation event(s)`);
      });
      await safe("health-score", () => computeHealthScore(c));
      if (c.analytics.records.enabled) await safe("records", updateRecords);
  }));

  // Slow loop: daily rollups + retention + spam + digest + weather + link budget every 30 min.
  const slowLoop = guardedInterval(30 * 60_000, () => safe("slow", async () => {
      const c = await effectiveConfig();
      // Re-fold before aggregating the day, so a late reception reaches the daily rows too.
      await safe("refold-hours", async () => {
        const n = await refoldRecentHours(c.analytics.rollups.refold_hours);
        if (n) console.log(`[worker] re-folded ${n} recent hour(s)`);
      });
      await safe("daily-rollups", async () => {
        const n = await runDailyRollups(c);
        if (n) console.log(`[worker] folded ${n} day(s)`);
      });
      await safe("retention", runRetention);
      await safe("tx-log-trim", () => trimTxLog(3));
      await safe("wx-alert-trim", () => trimAlertsSent(30));
      await safe("spam-scores", () => updateSpamScores(c));
      await safe("digest", () => maybeRunDigest(c));
      await safe("weather", () => ingestWeather(c));
      await safe("space-weather", () => ingestSpaceWeather(c));
      await safe("link-budget", () => computeLinkBudgets(c));
      await safe("relays", updateRelays);
      await safe("flapping", detectFlapping);
      await safe("conflicts", async () => {
        const n = await detectConflicts();
        if (n) console.log(`[worker] raised ${n} integrity conflict flag(s)`);
      });
      await safe("battery-forecast", computeBatteryForecasts);
      await safe("nodedb-maint", () => runNodeDbMaint());
      await safe("position-estimation", async () => {
        const written = await estimatePositions(c);
        if (written) console.log(`[worker] estimated ${written} node position(s)`);
      });
  }));

  // TX outbox: drain + confirm every 10s so arm/disarm and sends are responsive. The
  // transport is created once; runTxOutbox is a no-op until tx.enabled AND tx.armed.
  const txTransports = { mqtt: new MqttTxTransport(), node: new NodeTxTransport() };
  const txLoopH = guardedInterval(10_000, () => safe("tx-outbox", async () => {
      const c = await effectiveConfig();
      await safe("tx-announce", () => maybeAnnounce(c));
      await safe("tx-autoresponder", () => runAutoResponder(c));
      await safe("tx-spam-nudge", () => runSpamNudge(c));
      await safe("tx-welcome", () => runWelcome(c));
      await safe("auto-traceroute", async () => {
        const n = await runAutoTraceroute(c);
        if (n) console.log(`[worker] auto-traceroute queued ${n} node(s)`);
      });
      await safe("tx-admin-scan", () => runAdminScanner(c));
      await safe("tx-weather-alerts", () => runWeatherAlerts(c));
      await safe("tx-automations", () => runAutomations(c));
      // RF<->MQTT patcher (hold-timer). Enqueues MQTT->RF as outbox rows, so run it before the
      // outbox drain in the same tick; RF->MQTT publishes directly via the mqtt transport.
      await safe("bridge-patch", async () => {
        const p = await runMessagePatch(c, txTransports);
        if (p) console.log(`[worker] patched ${p} message(s) across RF<->MQTT`);
      });
      const n = await runTxOutbox(c, txTransports);
      if (n) console.log(`[worker] tx processed ${n} outbox row(s)`);
  }));

  // Kick once immediately so a fresh deploy isn't idle for a minute. Through the loop's own guard,
  // so this can never run concurrently with the first scheduled tick.
  fastLoop.kick();
  void safe("initial", async () => {
    const c = await effectiveConfig();
    await safe("spam-scores", () => updateSpamScores(c));
    await safe("baselines", () => updateBaselines(c));
    await safe("health-score", () => computeHealthScore(c));
  });

  const shutdown = async () => {
    console.log("[worker] shutting down…");
    clearInterval(fastLoop.timer);
    clearInterval(mediumLoop.timer);
    clearInterval(slowLoop.timer);
    clearInterval(txLoopH.timer);
    await txTransports.mqtt.close();
    await txTransports.node.close();
    await closeBrokerTransports();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(`[worker] fatal: ${e.message}`);
  process.exit(1);
});
