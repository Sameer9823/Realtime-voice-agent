import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../types.js";
import { TimeoutError } from "./timeout.js";

export interface RetryOptions {
  /** Max retry attempts after the initial try. Default: 3. */
  maxRetries?: number;
  /** Delay before the first retry, in ms. Default: 500. */
  initialDelayMs?: number;
  /** Ceiling on backoff delay, in ms. Default: 8000. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each retry. Default: 2. */
  backoffFactor?: number;
  /** Add random jitter (0-1 fraction of the delay) to avoid thundering-herd retries. Default: 0.2. */
  jitter?: number;
  /** Decide whether a given error should be retried. Default: retries 429/500/502/503/504 and common network errors. */
  retryOn?: (error: unknown) => boolean;
  /** Observability hook, called before each retry sleep. */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"]);

export function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  const err = error as any;
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (typeof status === "number" && RETRYABLE_STATUS_CODES.has(status)) return true;

  const code = err?.code;
  if (typeof code === "string" && RETRYABLE_ERROR_CODES.has(code)) return true;

  // Some SDKs throw errors whose name/message signal a rate limit or timeout
  const message = String(err?.message ?? "").toLowerCase();
  if (message.includes("rate limit") || message.includes("timeout") || message.includes("overloaded")) {
    return true;
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(attempt: number, opts: Required<Pick<RetryOptions, "initialDelayMs" | "maxDelayMs" | "backoffFactor" | "jitter">>): number {
  const base = Math.min(opts.initialDelayMs * Math.pow(opts.backoffFactor, attempt), opts.maxDelayMs);
  const jitterAmount = base * opts.jitter * Math.random();
  return Math.round(base + jitterAmount);
}

/**
 * Wraps any Provider with automatic retries on transient failures (rate limits,
 * 5xx errors, network blips). Retries use exponential backoff with jitter.
 *
 * For `stream()`, retries only apply before the first chunk has been yielded to
 * the caller — once streaming has started, a mid-stream failure is surfaced as-is
 * rather than silently restarted, since restarting would duplicate or drop output
 * the caller has already seen.
 */
export function withRetry(provider: Provider, options: RetryOptions = {}): Provider {
  const maxRetries = options.maxRetries ?? 3;
  const delayOpts = {
    initialDelayMs: options.initialDelayMs ?? 500,
    maxDelayMs: options.maxDelayMs ?? 8000,
    backoffFactor: options.backoffFactor ?? 2,
    jitter: options.jitter ?? 0.2,
  };
  const isRetryable = options.retryOn ?? defaultIsRetryable;

  async function generate(genOptions: GenerateOptions): Promise<GenerateResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await provider.generate(genOptions);
      } catch (err) {
        lastError = err;
        if (attempt === maxRetries || !isRetryable(err)) throw err;
        const delayMs = computeDelay(attempt, delayOpts);
        const info = { attempt: attempt + 1, error: err, delayMs };
        options.onRetry?.(info);
        genOptions.onRetry?.(info);
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  async function* stream(genOptions: GenerateOptions): AsyncIterable<StreamChunk> {
    let anyYielded = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        for await (const chunk of provider.stream(genOptions)) {
          anyYielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (anyYielded || attempt === maxRetries || !isRetryable(err)) throw err;
        const delayMs = computeDelay(attempt, delayOpts);
        const info = { attempt: attempt + 1, error: err, delayMs };
        options.onRetry?.(info);
        genOptions.onRetry?.(info);
        await sleep(delayMs);
      }
    }
  }

  return { name: provider.name, generate, stream };
}
