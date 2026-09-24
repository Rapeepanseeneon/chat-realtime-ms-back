export type RateLimitOptions = {
  capacity: number;
  refillWindowMs: number;
  cooldownMs: number;
  violationsBeforeCooldown?: number;
  idleTtlMs?: number;
  maxEntries?: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
};

type Bucket = {
  tokens: number;
  refilledAt: number;
  lastSeenAt: number;
  violations: number;
  blockedUntil: number;
};

/**
 * Process-local token bucket. The API deliberately stays storage-agnostic so a
 * distributed implementation can replace it later without changing handlers.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private operations = 0;
  private readonly options: Required<RateLimitOptions>;

  constructor(options: RateLimitOptions) {
    if (options.capacity < 1 || options.refillWindowMs < 1)
      throw new Error("Rate limiter capacity and window must be positive");
    this.options = {
      ...options,
      violationsBeforeCooldown: options.violationsBeforeCooldown ?? 3,
      idleTtlMs:
        options.idleTtlMs ??
        Math.max(options.refillWindowMs, options.cooldownMs) * 2,
      maxEntries: options.maxEntries ?? 20_000,
    };
  }

  consume(key: string, now = Date.now()): RateLimitDecision {
    this.operations += 1;
    if (this.operations % 128 === 0) this.sweep(now, false);
    if (!this.buckets.has(key) && this.buckets.size >= this.options.maxEntries)
      this.sweep(now, true);

    const bucket = this.buckets.get(key) ?? {
      tokens: this.options.capacity,
      refilledAt: now,
      lastSeenAt: now,
      violations: 0,
      blockedUntil: 0,
    };
    bucket.lastSeenAt = now;

    if (bucket.blockedUntil > now) {
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        retryAfterMs: bucket.blockedUntil - now,
        remaining: 0,
      };
    }

    const refillRate = this.options.capacity / this.options.refillWindowMs;
    bucket.tokens = Math.min(
      this.options.capacity,
      bucket.tokens + Math.max(0, now - bucket.refilledAt) * refillRate,
    );
    bucket.refilledAt = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      if (bucket.tokens >= 1) bucket.violations = 0;
      this.buckets.set(key, bucket);
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: Math.floor(bucket.tokens),
      };
    }

    bucket.violations += 1;
    const refillWait = Math.ceil((1 - bucket.tokens) / refillRate);
    if (bucket.violations >= this.options.violationsBeforeCooldown) {
      bucket.blockedUntil = now + this.options.cooldownMs;
      bucket.violations = 0;
    }
    this.buckets.set(key, bucket);
    return {
      allowed: false,
      retryAfterMs: Math.max(refillWait, bucket.blockedUntil - now),
      remaining: 0,
    };
  }

  delete(key: string) {
    this.buckets.delete(key);
  }

  clear() {
    this.buckets.clear();
  }

  get size() {
    return this.buckets.size;
  }

  private sweep(now: number, makeRoom: boolean) {
    for (const [key, bucket] of this.buckets) {
      if (
        bucket.lastSeenAt + this.options.idleTtlMs <= now &&
        bucket.blockedUntil <= now
      )
        this.buckets.delete(key);
    }
    if (!makeRoom || this.buckets.size < this.options.maxEntries) return;
    const oldest = [...this.buckets.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
      .slice(0, Math.max(1, this.buckets.size - this.options.maxEntries + 1));
    for (const [key] of oldest) this.buckets.delete(key);
  }
}
