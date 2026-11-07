import type Redis from 'ioredis';

/**
 * Fixed-window counters. Exam endpoints must keep working if Redis is down (T-05), so the Redis
 * store falls back to per-instance memory on any Redis error.
 */
export interface CounterStore {
  incr(key: string, windowSec: number): Promise<number>;
  get(key: string): Promise<number>;
  reset(key: string): Promise<void>;
}

export class MemoryCounterStore implements CounterStore {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async incr(key: string, windowSec: number): Promise<number> {
    this.sweep();
    const t = this.now();
    const e = this.entries.get(key);
    if (!e || e.expiresAt <= t) {
      this.entries.set(key, { count: 1, expiresAt: t + windowSec * 1000 });
      return 1;
    }
    e.count += 1;
    return e.count;
  }

  async get(key: string): Promise<number> {
    const e = this.entries.get(key);
    return e && e.expiresAt > this.now() ? e.count : 0;
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private sweep(): void {
    if (this.entries.size < 10_000) return;
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
  }
}

const INCR_SCRIPT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

export class RedisCounterStore implements CounterStore {
  constructor(
    private readonly redis: Redis,
    private readonly fallback: CounterStore = new MemoryCounterStore(),
  ) {}

  async incr(key: string, windowSec: number): Promise<number> {
    try {
      return Number(await this.redis.eval(INCR_SCRIPT, 1, `rl:${key}`, String(windowSec)));
    } catch {
      return this.fallback.incr(key, windowSec);
    }
  }

  async get(key: string): Promise<number> {
    try {
      const v = await this.redis.get(`rl:${key}`);
      return v ? Number(v) : 0;
    } catch {
      return this.fallback.get(key);
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(`rl:${key}`);
    } catch {
      await this.fallback.reset(key);
    }
  }
}
