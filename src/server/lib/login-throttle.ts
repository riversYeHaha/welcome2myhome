/**
 * In-memory failed-login throttle. One process, one host: a Map is enough and
 * avoids a database write on every wrong PIN.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 60_000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (list.length > 0) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  isBlocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.limit;
  }

  retryAfterSec(key: string, now = Date.now()): number {
    const list = this.recent(key, now);
    if (list.length === 0) return 0;
    const oldest = list[0]!;
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  recordFailure(key: string, now = Date.now()): void {
    const list = this.recent(key, now);
    list.push(now);
    this.failures.set(key, list);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
