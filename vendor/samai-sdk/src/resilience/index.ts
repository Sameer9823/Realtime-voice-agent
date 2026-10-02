import type { Provider } from "../types.js";
import { withRetry, type RetryOptions } from "./retry.js";
import { withFallback, type FallbackOptions } from "./fallback.js";
import { withTimeout, type TimeoutOptions } from "./timeout.js";

export interface ResilientProviderOptions {
  /** Applied to EACH provider innermost, so every individual attempt (including retries) gets its own timeout window. Default: 30s. Set to `false` to disable. */
  timeout?: TimeoutOptions | false;
  /** Retry settings applied to EACH provider individually before falling through to the next. */
  retry?: RetryOptions;
  fallback?: FallbackOptions;
}

/**
 * Convenience helper: wraps each provider with a timeout, then retry, then chains
 * them with fallback. Equivalent to
 * `withFallback(providers.map(p => withRetry(withTimeout(p, timeout), retry)), fallback)`.
 *
 * Example: `createResilientProvider([anthropic(), openai()], { retry: { maxRetries: 2 } })`
 * gives each attempt a 30s timeout, retries Claude up to twice on transient errors
 * (including timeouts), then falls through to GPT if Claude is still failing.
 */
export function createResilientProvider(
  providers: Provider[],
  options: ResilientProviderOptions = {}
): Provider {
  const timeoutOptions = options.timeout;
  const withTimeouts =
    timeoutOptions === false ? providers : providers.map((p) => withTimeout(p, timeoutOptions));
  const withRetries = withTimeouts.map((p) => withRetry(p, options.retry));
  return withFallback(withRetries, options.fallback);
}

export { withRetry, defaultIsRetryable } from "./retry.js";
export type { RetryOptions } from "./retry.js";

export { withFallback, AllProvidersFailedError } from "./fallback.js";
export type { FallbackOptions } from "./fallback.js";

export { withTimeout, TimeoutError } from "./timeout.js";
export type { TimeoutOptions } from "./timeout.js";

export { withConcurrencyLimit } from "./concurrency.js";
export type { ConcurrencyLimitOptions } from "./concurrency.js";

export { withRateLimit } from "./rate-limit.js";
export type { RateLimitOptions } from "./rate-limit.js";
