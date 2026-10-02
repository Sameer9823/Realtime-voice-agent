import type { Client } from "./client.js";
import type { Usage } from "./types.js";
import type { GenerateObjectOptions, GenerateObjectResult } from "./generate-object.js";
import { generateObject } from "./generate-object.js";

export interface GenerateObjectBatchOptions<TInput, TOutput> {
  /** The inputs to process — one `generateObject()` call is made per item. */
  items: TInput[];
  /** Builds the per-item `generateObject()` options (schema is usually shared; messages/system usually vary per item). */
  buildOptions: (item: TInput, index: number) => GenerateObjectOptions<TOutput>;
  /** Max calls in flight at once. Default: 5. */
  concurrency?: number;
  /**
   * Called as each item settles (in completion order, not input order) — useful for progress
   * bars or streaming partial results to a UI before the whole batch finishes.
   */
  onItemSettled?: (item: GenerateObjectBatchItemResult<TInput, TOutput>) => void;
  /**
   * If true, throw a `GenerateObjectBatchError` once every item has settled if any failed.
   * Default: false — failures are reported per-item in `results`, the batch call itself never rejects.
   */
  throwOnAnyFailure?: boolean;
}

export type GenerateObjectBatchItemResult<TInput, TOutput> =
  | { index: number; item: TInput; status: "fulfilled"; result: GenerateObjectResult<TOutput> }
  | { index: number; item: TInput; status: "rejected"; error: Error };

export interface GenerateObjectBatchResult<TInput, TOutput> {
  /** One entry per input item, in the SAME order as `items` (regardless of completion order). */
  results: GenerateObjectBatchItemResult<TInput, TOutput>[];
  succeeded: number;
  failed: number;
  /** Summed usage across every attempt that produced a result — including failed items' repair attempts, since those were still real calls that cost tokens. */
  usage: Usage;
}

export class GenerateObjectBatchError extends Error {
  constructor(public batchResult: GenerateObjectBatchResult<unknown, unknown>) {
    super(
      `generateObjectBatch: ${batchResult.failed}/${batchResult.results.length} item(s) failed. ` +
        `Inspect \`error.batchResult.results\` for per-item details.`
    );
    this.name = "GenerateObjectBatchError";
  }
}

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * Runs `generateObject()` across many inputs with bounded concurrency — the common shape of a
 * data-extraction pipeline (e.g. "classify these 500 support tickets"). Failures are isolated
 * per item: one bad input (fails validation even after repair, hits a rate limit, etc.) doesn't
 * abort the rest of the batch. Results come back in the same order as `items`, so `results[i]`
 * always corresponds to `items[i]` even though calls complete out of order.
 *
 * For total control over concurrency (retries jumping the queue vs not, sharing a limit across
 * unrelated calls too), wrap `client.provider` in `withConcurrencyLimit()` instead and set this
 * function's own `concurrency` high — the two compose, they just enforce the cap at different
 * layers (this one is scoped to a single batch call; `withConcurrencyLimit` is global to the provider).
 */
export async function generateObjectBatch<TInput, TOutput>(
  client: Client,
  options: GenerateObjectBatchOptions<TInput, TOutput>
): Promise<GenerateObjectBatchResult<TInput, TOutput>> {
  const { items, buildOptions, onItemSettled } = options;
  const concurrency = Math.max(1, options.concurrency ?? 5);

  const results: GenerateObjectBatchItemResult<TInput, TOutput>[] = new Array(items.length);
  let usage = zeroUsage();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index];

      let settled: GenerateObjectBatchItemResult<TInput, TOutput>;
      try {
        const result = await generateObject(client, buildOptions(item, index));
        usage = addUsage(usage, result.usage);
        settled = { index, item, status: "fulfilled", result };
      } catch (err) {
        // GenerateObjectError still carries the (failed) attempts' cumulative usage isn't
        // exposed on the error itself, so we can't add it here — only successful `result.usage`
        // is summed. This is a documented tradeoff, not an oversight: the error type would need
        // to carry usage for us to count tokens spent on a call that ultimately failed.
        const error = err instanceof Error ? err : new Error(String(err));
        settled = { index, item, status: "rejected", error };
      }

      results[index] = settled;
      onItemSettled?.(settled);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - succeeded;
  const batchResult: GenerateObjectBatchResult<TInput, TOutput> = { results, succeeded, failed, usage };

  if (options.throwOnAnyFailure && failed > 0) {
    throw new GenerateObjectBatchError(batchResult as GenerateObjectBatchResult<unknown, unknown>);
  }

  return batchResult;
}
