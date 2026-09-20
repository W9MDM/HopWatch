// In-memory fixed-window rate limiter. Adequate for a single-process self-hosted web tier
// (not distributed). Used to throttle admin login brute force. Each call counts one attempt.
interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, max: number, windowMs: number): { limited: boolean; retryAfterS: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k); // opportunistic prune
  return b.count > max ? { limited: true, retryAfterS: Math.ceil((b.resetAt - now) / 1000) } : { limited: false, retryAfterS: 0 };
}

export function rateLimitReset(key: string): void {
  buckets.delete(key);
}
