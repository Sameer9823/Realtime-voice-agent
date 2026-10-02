import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../types.js";

export interface RateLimitOptions {
  /** Max calls allowed per `intervalMs` window. Default: 60. */
  maxRequests?: number;
  /** Window size in ms. Default: 60000 (i.e. `maxRequests` per minute). */
  intervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Token-bucket limiter: refills continuously at `maxRequests / intervalMs` tokens/ms, capped at `maxRequests`. */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private maxRequests: number, private intervalMs: number) {
    this.tokens = maxRequests;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillRate = this.maxRequests / this.intervalMs; // tokens per ms
    this.tokens = Math.min(this.maxRequests, this.tokens + elapsed * refillRate);
    this.lastRefill = now;
  }

  /** Resolves once a token is available, consuming it. Waits (queues) rather than rejecting. */
  async take(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const tokensNeeded = 1 - this.tokens;
      const msToWait = tokensNeeded / (this.maxRequests / this.intervalMs);
      await sleep(Math.max(1, Math.ceil(msToWait)));
    }
  }
}

/**
 * Caps calls to `provider` to `maxRequests` per `intervalMs` — a queue, not a rejection: calls
 * beyond the limit wait for capacity rather than erroring. Use this to stay under a provider's
 * published rate limit (e.g. "60 requests/minute") without hand-rolling a limiter around every
 * call site, or hitting 429s that `withRetry` then has to spend time recovering from.
 *
 * For a hard concurrent-in-flight cap instead of a requests-per-window cap, see
 * `withConcurrencyLimit()` — the two compose fine together.
 */
export function withRateLimit(provider: Provider, options: RateLimitOptions = {}): Provider {
  const bucket = new TokenBucket(options.maxRequests ?? 60, options.intervalMs ?? 60_000);

  async function generate(genOptions: GenerateOptions): Promise<GenerateResult> {
    await bucket.take();
    return provider.generate(genOptions);
  }

  async function* stream(genOptions: GenerateOptions): AsyncIterable<StreamChunk> {
    await bucket.take();
    yield* provider.stream(genOptions);
  }

  return { name: provider.name, generate, stream };
}
