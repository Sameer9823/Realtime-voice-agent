import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../types.js";

export interface ConcurrencyLimitOptions {
  /** Max calls (generate + stream combined) allowed in flight at once. Default: 5. */
  maxConcurrent?: number;
}

/** A simple counting semaphore — no dependencies, just enough for `withConcurrencyLimit()`. */
class Semaphore {
  private available: number;
  private queue: (() => void)[] = [];

  constructor(max: number) {
    this.available = max;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.available--;
  }

  release(): void {
    this.available++;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Calls currently waiting for a slot to free up — useful for tests/observability. */
  get queueLength(): number {
    return this.queue.length;
  }
}

/**
 * Caps how many calls to `provider` can be in flight at once — a queue, not a rejection: calls
 * beyond `maxConcurrent` wait for a slot rather than erroring. Useful when running many agents
 * or batch `generateObject()` calls concurrently against a provider with a hard concurrent-request
 * limit, so you don't need to hand-roll your own queueing around every call site.
 *
 * Compose with `withRetry`/`withTimeout`/`withFallback` as needed — order matters: wrapping
 * `withConcurrencyLimit` around `withRetry` means retries of the SAME call count against the
 * concurrency limit too (usually what you want); the reverse lets retries jump the queue.
 */
export function withConcurrencyLimit(provider: Provider, options: ConcurrencyLimitOptions = {}): Provider {
  const semaphore = new Semaphore(options.maxConcurrent ?? 5);

  async function generate(genOptions: GenerateOptions): Promise<GenerateResult> {
    await semaphore.acquire();
    try {
      return await provider.generate(genOptions);
    } finally {
      semaphore.release();
    }
  }

  async function* stream(genOptions: GenerateOptions): AsyncIterable<StreamChunk> {
    await semaphore.acquire();
    try {
      yield* provider.stream(genOptions);
    } finally {
      semaphore.release();
    }
  }

  return { name: provider.name, generate, stream };
}
