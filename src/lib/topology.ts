// Pure helpers for building mesh topology from traceroute paths. No DB access so they are
// unit-testable; src/db/topology.ts persists what these produce.

/** Order a node pair canonically (smaller id first) so an undirected edge has one key. */
export function canonicalEdge(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * Consecutive hops of a traceroute path as canonical undirected edges, dropping zero/self
 * hops. A path [A, B, C] yields edges [A,B] and [B,C]. `snrAt(i)` optionally supplies the
 * SNR for hop i (towards the destination) if the RouteDiscovery carried it.
 */
export function pathEdges(path: number[], snrAt?: (i: number) => number | null): { a: number; b: number; snr: number | null }[] {
  const out: { a: number; b: number; snr: number | null }[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const x = path[i] ?? 0, y = path[i + 1] ?? 0;
    if (!x || !y || x === y) continue;
    const [a, b] = canonicalEdge(x, y);
    out.push({ a, b, snr: snrAt ? snrAt(i) : null });
  }
  return out;
}
