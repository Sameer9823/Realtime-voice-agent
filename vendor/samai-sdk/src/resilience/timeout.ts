import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../types.js";

/** Thrown when a call is aborted by `withTimeout()` because it took longer than `timeoutMs`. */
export class TimeoutError extends Error {
  constructor(public timeoutMs: number, public model: string) {
    super(`Call to model "${model}" timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export interface TimeoutOptions {
  /** Default timeout applied to every call, in ms. Default: 30000. Overridable per-call via `GenerateOptions.timeoutMs`. */
  timeoutMs?: number;
  /** Called once a call is aborted for timing out, before the TimeoutError is thrown. */
  onTimeout?: (info: { model: string; timeoutMs: number }) => void;
}

/**
 * Wraps any Provider so every `generate()`/`stream()` call is aborted if it
 * doesn't produce a first result (or first chunk) within `timeoutMs`.
 *
 * This is a real enforcement mechanism, not error-message sniffing: it wires
 * an `AbortController` into the call (merged with any `signal` the caller
 * already passed) and races it against a timer. Composes with `withRetry()`
 * and `withFallback()` since it just implements the same `Provider` interface
 * — put it innermost (`withRetry(withTimeout(provider))`) so each attempt
 * gets its own fresh timeout window.
 *
 * For `stream()`, the timeout only guards the gap *before* the first chunk
 * arrives — once tokens are flowing, a slow-but-live stream isn't aborted
 * mid-response.
 */
export function withTimeout(provider: Provider, options: TimeoutOptions = {}): Provider {
  const defaultTimeoutMs = options.timeoutMs ?? 30_000;

  function mergeSignal(callerSignal: AbortSignal | undefined, controller: AbortController): void {
    if (!callerSignal) return;
    if (callerSignal.aborted) {
      controller.abort();
      return;
    }
    callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  async function generate(genOptions: GenerateOptions): Promise<GenerateResult> {
    const timeoutMs = genOptions.timeoutMs ?? defaultTimeoutMs;
    const controller = new AbortController();
    mergeSignal(genOptions.signal, controller);

    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await provider.generate({ ...genOptions, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        const info = { model: genOptions.model, timeoutMs };
        options.onTimeout?.(info);
        genOptions.onTimeout?.(info);
        throw new TimeoutError(timeoutMs, genOptions.model);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function* stream(genOptions: GenerateOptions): AsyncIterable<StreamChunk> {
    const timeoutMs = genOptions.timeoutMs ?? defaultTimeoutMs;
    const controller = new AbortController();
    mergeSignal(genOptions.signal, controller);

    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let receivedFirstChunk = false;
    try {
      for await (const chunk of provider.stream({ ...genOptions, signal: controller.signal })) {
        if (!receivedFirstChunk) {
          receivedFirstChunk = true;
          clearTimeout(timer); // once the stream is live, let it run to completion
        }
        yield chunk;
      }
    } catch (err) {
      if (controller.signal.aborted && !receivedFirstChunk) {
        const info = { model: genOptions.model, timeoutMs };
        options.onTimeout?.(info);
        genOptions.onTimeout?.(info);
        throw new TimeoutError(timeoutMs, genOptions.model);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return { name: provider.name, generate, stream };
}
