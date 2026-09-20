// Pure planning for on-device NodeDB pruning. DB- and IO-free so it is unit-testable; the node
// admin routine (src/node/writeconfig.ts) reads the device NodeDB and applies this plan over the
// stream API. Keeping the station node's NodeDB trimmed matters on RAM-constrained boards (ESP32),
// where a bloated DB can OOM and reboot-loop.

/** Meshtastic device roles that act as infrastructure; never pruned, and favorited so the firmware's
 *  own eviction also protects them. ROUTER_CLIENT is deprecated upstream but kept for old nodes. */
export const REPEATER_ROLES = new Set(["ROUTER", "REPEATER", "ROUTER_CLIENT", "ROUTER_LATE"]);

export interface NodeDbEntryLite {
  num: number;
  role?: string;      // device role name (CLIENT, ROUTER, REPEATER, ...) as the node reported it
  last_heard: number; // unix seconds; 0 = never/unknown
}

export interface NodeDbPlan {
  favorite: number[]; // repeaters/routers to mark favorite (protected from prune + firmware eviction)
  remove: number[];   // stale non-infrastructure nodes to drop
  keep: number[];     // left as-is (recent, self, or repeater when not favoriting)
}

/**
 * Decide which nodes to favorite, remove, or keep.
 * - self (myNodeNum) and num 0 are always kept.
 * - a node is "infrastructure" if its role is a repeater/router OR its num is in repeaterNums
 *   (HopWatch's own classification, which catches repeaters the node labeled CLIENT). Infrastructure
 *   is favorited (when favoriteRepeaters) and never removed.
 * - any other node last heard before the stale cutoff is removed; last_heard 0 counts as stale.
 */
export function planNodeDbPrune(
  nodes: NodeDbEntryLite[],
  myNodeNum: number,
  opts: { staleDays: number; favoriteRepeaters: boolean; repeaterNums?: number[]; nowSec: number },
): NodeDbPlan {
  const cutoff = opts.nowSec - opts.staleDays * 86400;
  const rep = new Set(opts.repeaterNums ?? []);
  const plan: NodeDbPlan = { favorite: [], remove: [], keep: [] };
  for (const n of nodes) {
    if (n.num === myNodeNum || n.num === 0) { plan.keep.push(n.num); continue; }
    const isInfra = REPEATER_ROLES.has((n.role ?? "").toUpperCase()) || rep.has(n.num);
    if (isInfra) {
      if (opts.favoriteRepeaters) plan.favorite.push(n.num);
      else plan.keep.push(n.num);
      continue;
    }
    if (n.last_heard < cutoff) plan.remove.push(n.num); // includes last_heard == 0 (unknown/old)
    else plan.keep.push(n.num);
  }
  return plan;
}
