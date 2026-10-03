import type { RateLimiter, RateLimitResult } from "./guard";

/**
 * Optional shared rate-limit store.
 *
 * The in-memory limiter is correct for a single Node process, because the event loop serialises
 * access to its map. It is wrong the moment the app runs on two instances: each keeps its own
 * counters, so the effective limit doubles with every replica, and a rolling deploy briefly serves
 * both. `RateLimiter` exists as an interface precisely so this can be dropped in without touching
 * `guard.ts`.
 *
 * Upstash is loaded through a variable specifier and only when its environment variables are set, so
 * the app keeps no Redis dependency for the common single-instance case.
 */

type PipelineResult = { result: number };

/** Mirrors the chainable Upstash pipeline: queue calls, then `exec()` for the results in order. */
type UpstashPipeline = {
  incr: (key: string) => UpstashPipeline;
  pttl: (key: string) => UpstashPipeline;
  expire: (key: string, seconds: number) => UpstashPipeline;
  exec: () => Promise<[PipelineResult, PipelineResult]>;
};

type UpstashClient = {
  pipeline: () => UpstashPipeline;
};

type Loader = (specifier: string) => Promise<{ Redis: new (config: { url: string; token: string }) => UpstashClient }>;

const defaultLoader: Loader = async (specifier) =>
  (await import(/* webpackIgnore: true */ specifier)) as {
    Redis: new (config: { url: string; token: string }) => UpstashClient;
  };

/** Fixed-window limiter backed by Upstash Redis, so limits hold across instances. */
export class UpstashRateLimiter implements RateLimiter {
  private readonly redis: UpstashClient;
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly prefix: string;

  constructor(redis: UpstashClient, windowMs: number, maxRequests: number, prefix = "rl:") {
    this.redis = redis;
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.prefix = prefix;
  }

  async check(key: string): Promise<RateLimitResult> {
    // A counter and its expiry have to be written together: incrementing without setting a TTL
    // would leave a key that never expires and permanently locks that caller out.
    const pipeline = this.redis.pipeline();
    pipeline.incr(this.prefix + key);
    pipeline.pttl(this.prefix + key);
    const [incremented, ttl] = await pipeline.exec();

    const count = incremented.result;
    if (count === 1) {
      await this.redis.pipeline().expire(this.prefix + key, Math.ceil(this.windowMs / 1000)).exec();
    }

    if (count <= this.maxRequests) return { allowed: true, retryAfterMs: 0 };
    // `pttl` reports -1 for a key with no expiry and -2 for a missing key, so neither is a usable
    // wait; fall back to the window rather than telling the caller to retry after -1ms.
    const remaining = ttl.result > 0 ? ttl.result : this.windowMs;
    return { allowed: false, retryAfterMs: remaining };
  }
}

/**
 * Builds a shared limiter when Upstash is configured, otherwise returns null so the caller keeps
 * the in-memory default. Returns null rather than throwing: a missing Redis degrades the limit, it
 * does not take the app down.
 */
export async function upstashLimiterFromEnv(
  env: Record<string, string | undefined> = process.env,
  loader: Loader = defaultLoader,
): Promise<UpstashRateLimiter | null> {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const windowMs = Number(env.RATE_LIMIT_WINDOW_MS) || 60_000;
  const maxRequests = Number(env.RATE_LIMIT_MAX) || 20;

  try {
    const { Redis } = await loader(/* webpackIgnore: true */ "@upstash/redis");
    return new UpstashRateLimiter(new Redis({ url, token }), windowMs, maxRequests, env.RATE_LIMIT_PREFIX ?? "rl:");
  } catch (err) {
    console.warn("[ratelimit] Upstash not initialised, falling back to in-memory:", err instanceof Error ? err.message : err);
    return null;
  }
}
