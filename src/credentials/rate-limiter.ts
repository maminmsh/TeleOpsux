/**
 * Fixed-window in-memory rate limiter for the credential endpoint. The form
 * server is single-process, so a Map is enough — this throttles brute force
 * against the initData signature and PAT guessing, not a global DoS shield
 * (a reverse proxy should provide that layer).
 */
export interface RateLimitRule {
  /** Max accepted events per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    private rules: Record<string, RateLimitRule>,
    private now: () => number = () => Date.now(),
  ) {}

  /**
   * Consume one unit of `rule` for `key`. Returns null when allowed, or the
   * milliseconds until the window resets when the caller is over the limit.
   */
  check(rule: string, key: string, cost = 1): number | null {
    const cfg = this.rules[rule];
    if (!cfg) return null;
    const t = this.now();
    this.sweep(t);

    const id = rule + "|" + key;
    const bucket = this.buckets.get(id);
    if (!bucket || bucket.resetAt <= t) {
      this.buckets.set(id, { count: cost, resetAt: t + cfg.windowMs });
      return null;
    }
    bucket.count += cost;
    if (bucket.count <= cfg.limit) return null;
    return bucket.resetAt - t;
  }

  /** Failed-auth attempts are more expensive than ordinary page loads. */
  penalty(rule: string, key: string, cost: number): void {
    if (!this.rules[rule]) return;
    const t = this.now();
    this.sweep(t);
    const id = rule + "|" + key;
    const bucket = this.buckets.get(id);
    if (!bucket || bucket.resetAt <= t)
      this.buckets.set(id, { count: cost, resetAt: t + this.rules[rule]!.windowMs });
    else bucket.count += cost;
  }

  /** Drop windows that have already expired so the map cannot grow forever. */
  private sweep(t: number): void {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [id, bucket] of this.buckets)
      if (bucket.resetAt <= t) this.buckets.delete(id);
  }
}
