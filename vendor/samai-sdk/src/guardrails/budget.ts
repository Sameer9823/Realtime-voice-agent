import type { GuardrailResult, InputGuardrail, OutputGuardrail, Usage } from "../types.js";

export interface ModelPricing {
  /** USD per 1M input tokens */
  inputPerMillion: number;
  /** USD per 1M output tokens */
  outputPerMillion: number;
}

// Rough, illustrative pricing — override via the `pricing` option with current rates,
// since provider pricing changes over time and this table will drift out of date.
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 0.8, outputPerMillion: 4 },
  "gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
};

function estimateCostUsd(model: string, usage: Usage, pricing: Record<string, ModelPricing>): number {
  const rate = pricing[model];
  if (!rate) return 0; // unknown model — can't estimate, don't block on it
  return (
    (usage.inputTokens / 1_000_000) * rate.inputPerMillion +
    (usage.outputTokens / 1_000_000) * rate.outputPerMillion
  );
}

export interface BudgetGuardrailOptions {
  maxTotalTokens?: number;
  maxCostUsd?: number;
  /** Override/extend the built-in pricing table for cost estimation */
  pricing?: Record<string, ModelPricing>;
  /** Called whenever usage is recorded, useful for external metering/dashboards */
  onUsage?: (info: { totalTokens: number; totalCostUsd: number; lastUsage: Usage }) => void;
}

export interface BudgetTracker {
  /** Blocks new calls once the budget is exceeded — use as an inputGuardrail */
  inputGuardrail: InputGuardrail;
  /** Records usage after each call — use as an outputGuardrail */
  outputGuardrail: OutputGuardrail;
  /** Read current cumulative usage/cost at any time */
  getStats: () => { totalTokens: number; totalCostUsd: number };
  /** Reset the counters, e.g. at the start of a new billing period or session */
  reset: () => void;
}

/**
 * Creates a paired input/output guardrail that tracks cumulative token usage and
 * estimated cost across every call made through a client, and blocks further calls
 * once a cap is hit. Register both guardrails on the same `createClient()` call:
 *
 *   const budget = createBudgetGuardrail({ maxCostUsd: 1.0 });
 *   createClient({ provider, inputGuardrails: [budget.inputGuardrail], outputGuardrails: [budget.outputGuardrail] });
 */
export function createBudgetGuardrail(options: BudgetGuardrailOptions = {}): BudgetTracker {
  const pricing = { ...DEFAULT_PRICING, ...(options.pricing ?? {}) };
  let totalTokens = 0;
  let totalCostUsd = 0;

  const inputGuardrail: InputGuardrail = (): GuardrailResult => {
    if (options.maxTotalTokens && totalTokens >= options.maxTotalTokens) {
      return { allowed: false, reason: `Token budget exceeded (${totalTokens}/${options.maxTotalTokens})` };
    }
    if (options.maxCostUsd && totalCostUsd >= options.maxCostUsd) {
      return {
        allowed: false,
        reason: `Cost budget exceeded ($${totalCostUsd.toFixed(4)}/$${options.maxCostUsd})`,
      };
    }
    return { allowed: true };
  };

  const outputGuardrail: OutputGuardrail = ({ result }): GuardrailResult => {
    totalTokens += result.usage.totalTokens;
    totalCostUsd += estimateCostUsd(result.model, result.usage, pricing);
    options.onUsage?.({ totalTokens, totalCostUsd, lastUsage: result.usage });
    return { allowed: true };
  };

  return {
    inputGuardrail,
    outputGuardrail,
    getStats: () => ({ totalTokens, totalCostUsd }),
    reset: () => {
      totalTokens = 0;
      totalCostUsd = 0;
    },
  };
}

/** Helper to fold in cost estimation when you know the model name at call time. */
export function estimateCallCost(
  model: string,
  usage: Usage,
  pricing: Record<string, ModelPricing> = DEFAULT_PRICING
): number {
  return estimateCostUsd(model, usage, pricing);
}
