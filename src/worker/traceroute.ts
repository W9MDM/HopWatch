import type { HopWatchConfig } from "../config/schema.ts";
import { claimTracerouteTargets } from "../db/topology.ts";
import { enqueueTx, tracerouteQueued, lastAutoTracerouteMs } from "../db/tx.ts";

// Auto-traceroute scheduler. Emits at most one batch every `send_every_minutes`, and never while a
// traceroute is still pending in the queue (no stacking). Targets are active nodes whose route is
// missing or stale, never re-traced inside their freshness interval. Enqueued rows go through the
// TX outbox (arm state, rate limits, mute list, hop cap). Returns the number enqueued.
export async function runAutoTraceroute(cfg: HopWatchConfig): Promise<number> {
  const t = cfg.tx.auto_traceroute;
  // A traceroute must actually transmit, so require the full TX gate (not dry-run).
  if (!cfg.tx.enabled || !cfg.tx.armed || cfg.tx.dry_run || !t.enabled) return 0;
  if (cfg.tx.from_node <= 0) return 0;
  // Never stack: if a traceroute is still queued/held, wait for it to clear first.
  if (await tracerouteQueued()) return 0;
  // Cadence: at most one batch per send_every_minutes.
  const every = Math.max(1, t.send_every_minutes) * 60_000;
  const last = await lastAutoTracerouteMs();
  if (last && Date.now() - last < every) return 0;

  const targets = await claimTracerouteTargets({
    fromNode: cfg.tx.from_node,
    intervalHours: t.interval_hours,
    maxActiveAgeHours: t.max_active_age_hours,
    limit: t.max_per_run,
    onlyRouters: t.only_routers,
  });

  for (const toNode of targets) {
    await enqueueTx({
      createdBy: "auto-traceroute",
      transport: t.transport === "mqtt" ? "mqtt" : "node", // "rf" -> node transport
      kind: "traceroute",
      toNode,
      fromNode: cfg.tx.from_node,
      hopLimit: cfg.tx.max_hop_limit,
      wantAck: false,
    });
  }
  return targets.length;
}
