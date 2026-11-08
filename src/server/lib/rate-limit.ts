/**
 * Sliding-window limiter for anti-brute-force protection. In-memory is enough
 * for a single-process home server; the window is intentionally short so a
 * human retry loop never notices it.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (list.length > 0) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  allow(key: string, now = Date.now()): boolean {
    const list = this.recent(key, now);
    if (list.length >= this.limit) return false;
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  retryAfterSec(key: string, now = Date.now()): number {
    const list = this.recent(key, now);
    if (list.length === 0) return 0;
    const oldest = list[0]!;
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }
}
