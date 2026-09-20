// In-process dedup LRU with TTL. Collapses repeated MQTT deliveries of the same
// (from, packetId, gateway) within the idempotency window before they hit the DB.
// The DB unique key on receptions is the authoritative backstop (spec §2).

interface Entry {
  exp: number;
  /** Fidelity of the copy that claimed this key. See `seen`. */
  rank: number;
}

export class DedupCache {
  private map = new Map<string, Entry>();
  private ttlMs: number;
  private maxEntries: number;

  // Explicit field assignment rather than TypeScript parameter properties: the daemons run under
  // tsx (full transform) but `npm test` runs `node --test`, which is strip-only and rejects
  // parameter properties outright. Keeping this module loadable under strip-only is what lets the
  // dedup invariants be unit-tested at all.
  constructor(ttlMs: number, maxEntries = 200_000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /** Update the TTL in place (hot-reload of the idempotency window); existing entries keep
   * their already-computed expiry, new entries use the new TTL. */
  setTtl(ttlMs: number): void {
    this.ttlMs = ttlMs;
  }

  /**
   * Returns true if this key was already claimed by a copy of equal or better fidelity
   * (i.e. this delivery is a duplicate that should be dropped).
   *
   * `rank` expresses how much information the copy carries. A broker subscribed to a whole
   * subtree (the seeded `msh/#`) receives BOTH the protobuf `/2/e/` and the JSON `/2/json/`
   * publication of the same packet, and they produce an identical key. The JSON projection is
   * lossy: the firmware's serializer emits no ok_to_mqtt, no want_ack and no relay_node, and
   * HopWatch does not parse traceroute or neighborinfo out of it. Worse, the JSON decode path is
   * synchronous while the protobuf path awaits, so the JSON copy reliably claimed the key first
   * and the richer copy was discarded whole.
   *
   * A strictly higher rank therefore SUPERSEDES an existing claim (returns false, so the better
   * copy is processed), while an equal or lower rank is still treated as a duplicate. Repeat
   * deliveries of the same format continue to collapse exactly as before.
   */
  seen(key: string, nowMs: number, rank = 0): boolean {
    const e = this.map.get(key);
    if (e !== undefined && e.exp > nowMs) {
      if (rank > e.rank) {
        // Better copy of a packet we have already seen: let it through once, and record the new
        // high-water mark so a third delivery at this rank is still deduped.
        e.rank = rank;
        e.exp = nowMs + this.ttlMs;
        return false;
      }
      return true;
    }
    this.map.set(key, { exp: nowMs + this.ttlMs, rank });
    if (this.map.size > this.maxEntries) this.evict(nowMs);
    return false;
  }

  private evict(nowMs: number): void {
    // Drop expired first; if still over, drop oldest-inserted (Map preserves order).
    for (const [k, e] of this.map) {
      if (e.exp <= nowMs) this.map.delete(k);
      if (this.map.size <= this.maxEntries) return;
    }
    while (this.map.size > this.maxEntries) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Fidelity ranks for `DedupCache.seen`, lowest to highest.
 *
 * JSON is a lossy projection of the protobuf, so protobuf supersedes it. Station-node RF is
 * authoritative and outranks both: it is a first-hand observation with true RF metadata, and the
 * RF path deliberately claims the shared key so the node's own later MQTT uplink of the same
 * reception is suppressed. Ranking RF top preserves that suppression, which a plain
 * protobuf-beats-JSON rule would otherwise break by letting the MQTT echo supersede it.
 */
export const RANK_JSON = 0;
export const RANK_PROTOBUF = 1;
export const RANK_RF = 2;

/** Rank of a decoded MQTT envelope (JSON topic vs protobuf topic). */
export function fidelityRank(fromJson: boolean): number {
  return fromJson ? RANK_JSON : RANK_PROTOBUF;
}
