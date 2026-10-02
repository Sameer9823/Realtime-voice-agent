import type { GenerateOptions, GenerateResult, Provider, StreamChunk, Usage } from "./types.js";
import { DEFAULT_PRICING, estimateCallCost, type ModelPricing } from "./guardrails/budget.js";

export interface UsageLedgerModelStats {
  totalTokens: number;
  totalCostUsd: number;
  callCount: number;
}

export interface UsageLedgerStats {
  totalTokens: number;
  totalCostUsd: number;
  callCount: number;
  /** Same totals broken down per model, e.g. to see "gpt-4o cost $X of this session's $Y total". */
  byModel: Record<string, UsageLedgerModelStats>;
}

export interface UsageLedgerOptions {
  /** Override/extend the built-in pricing table — same shape as `createBudgetGuardrail()`'s. */
  pricing?: Record<string, ModelPricing>;
  /** Fires after every recorded call — wire this to an external metrics/dashboard sink. */
  onRecord?: (info: { key: string; stats: UsageLedgerStats; last: { model: string; usage: Usage; costUsd: number } }) => void;
}

function emptyStats(): UsageLedgerStats {
  return { totalTokens: 0, totalCostUsd: 0, callCount: 0, byModel: {} };
}

function cloneStats(stats: UsageLedgerStats): UsageLedgerStats {
  return {
    ...stats,
    byModel: Object.fromEntries(Object.entries(stats.byModel).map(([model, s]) => [model, { ...s }])),
  };
}

export interface UsageLedgerSnapshot {
  generatedAt: string;
  entries: Array<{ key: string } & UsageLedgerStats>;
}

export interface UsageLedger {
  /** Records one call's usage against `key` (e.g. a session id or user id). Usually called via `wrapProvider()` rather than directly. */
  record(key: string, model: string, usage: Usage): void;
  /** Current cumulative stats for one key. Returns zeroed stats (not undefined) for a key that's never recorded anything. */
  getStats(key: string): UsageLedgerStats;
  /** Every key that has recorded at least one call, and its stats. */
  getAllStats(): Record<string, UsageLedgerStats>;
  /** Clears one key's stats, or every key's if none is given. */
  reset(key?: string): void;
  /** JSON-serializable snapshot of every key's stats — feed this to a dashboard or log it periodically. */
  toJSON(): UsageLedgerSnapshot;
  /**
   * Wraps a `Provider` so every `generate()`/`stream()` call through it is automatically recorded
   * against a key derived from that call's `GenerateOptions` (typically `options.metadata.sessionId`
   * or `.userId` — see `metadata` on `GenerateOptions`). Calls where `keyFn` returns `undefined` are
   * recorded under `"_unattributed"` rather than silently dropped, so total spend is never undercounted.
   *
   * Usage:
   *   const ledger = createUsageLedger();
   *   const provider = ledger.wrapProvider(openai(), (options) => options.metadata?.sessionId as string);
   *   const client = createClient({ provider });
   *   // ...later, per session:
   *   ledger.getStats("session-123");
   */
  wrapProvider(provider: Provider, keyFn: (options: GenerateOptions) => string | undefined): Provider;
}

const UNATTRIBUTED_KEY = "_unattributed";

/**
 * Tracks cumulative token usage and estimated cost across many sessions/users, keyed by
 * whatever string you attribute each call to. `createBudgetGuardrail()` answers "has THIS
 * client exceeded its budget" with one running total; this answers "how much has each
 * session/user cost so far", which a single guardrail-scoped counter can't do since it has
 * no notion of separate keys.
 */
export function createUsageLedger(options: UsageLedgerOptions = {}): UsageLedger {
  const pricing = { ...DEFAULT_PRICING, ...(options.pricing ?? {}) };
  const byKey = new Map<string, UsageLedgerStats>();

  function record(key: string, model: string, usage: Usage): void {
    const costUsd = estimateCallCost(model, usage, pricing);
    const stats = byKey.get(key) ?? emptyStats();

    stats.totalTokens += usage.totalTokens;
    stats.totalCostUsd += costUsd;
    stats.callCount += 1;

    const modelStats = stats.byModel[model] ?? { totalTokens: 0, totalCostUsd: 0, callCount: 0 };
    modelStats.totalTokens += usage.totalTokens;
    modelStats.totalCostUsd += costUsd;
    modelStats.callCount += 1;
    stats.byModel[model] = modelStats;

    byKey.set(key, stats);
    options.onRecord?.({ key, stats: cloneStats(stats), last: { model, usage, costUsd } });
  }

  function getStats(key: string): UsageLedgerStats {
    const stats = byKey.get(key);
    return stats ? cloneStats(stats) : emptyStats();
  }

  function getAllStats(): Record<string, UsageLedgerStats> {
    return Object.fromEntries(Array.from(byKey.entries()).map(([key, stats]) => [key, cloneStats(stats)]));
  }

  function reset(key?: string): void {
    if (key === undefined) byKey.clear();
    else byKey.delete(key);
  }

  function toJSON(): UsageLedgerSnapshot {
    return {
      generatedAt: new Date().toISOString(),
      entries: Array.from(byKey.entries()).map(([key, stats]) => ({ key, ...cloneStats(stats) })),
    };
  }

  function wrapProvider(provider: Provider, keyFn: (options: GenerateOptions) => string | undefined): Provider {
    async function generate(genOptions: GenerateOptions): Promise<GenerateResult> {
      const result = await provider.generate(genOptions);
      record(keyFn(genOptions) ?? UNATTRIBUTED_KEY, result.model, result.usage);
      return result;
    }

    async function* stream(genOptions: GenerateOptions): AsyncIterable<StreamChunk> {
      for await (const chunk of provider.stream(genOptions)) {
        if (chunk.type === "finish") {
          record(keyFn(genOptions) ?? UNATTRIBUTED_KEY, genOptions.model, chunk.usage);
        }
        yield chunk;
      }
    }

    return { name: provider.name, generate, stream };
  }

  return { record, getStats, getAllStats, reset, toJSON, wrapProvider };
}
