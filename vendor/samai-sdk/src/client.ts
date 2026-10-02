import type {
  GenerateOptions,
  GenerateResult,
  InputGuardrail,
  OutputGuardrail,
  Provider,
  StreamChunk,
} from "./types.js";

export interface ClientOptions {
  provider: Provider;
  /** Guardrails run in order; the first blocking one stops the call */
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail[];
}

export class GuardrailBlockedError extends Error {
  constructor(public reason: string, public stage: "input" | "output") {
    super(`Blocked by ${stage} guardrail: ${reason}`);
    this.name = "GuardrailBlockedError";
  }
}

/**
 * Creates a provider-agnostic client. Swap `provider` to switch between
 * OpenAI, Anthropic, and Google without touching call sites.
 */
export function createClient(opts: ClientOptions) {
  async function runInputGuardrails(options: GenerateOptions) {
    let messages = options.messages;
    for (const guardrail of opts.inputGuardrails ?? []) {
      const result = await guardrail({ messages });
      if (!result.allowed) {
        throw new GuardrailBlockedError(result.reason ?? "unspecified", "input");
      }
      if (result.modifiedMessages) messages = result.modifiedMessages;
    }
    return messages;
  }

  async function runOutputGuardrails(result: GenerateResult) {
    let current = result;
    for (const guardrail of opts.outputGuardrails ?? []) {
      const outcome = await guardrail({ result: current });
      if (!outcome.allowed) {
        throw new GuardrailBlockedError(outcome.reason ?? "unspecified", "output");
      }
      if (outcome.modifiedResult) current = outcome.modifiedResult;
    }
    return current;
  }

  async function generate(options: GenerateOptions): Promise<GenerateResult> {
    const messages = await runInputGuardrails(options);
    const result = await opts.provider.generate({ ...options, messages });
    return runOutputGuardrails(result);
  }

  // Streaming applies input guardrails up front; output guardrails don't apply
  // token-by-token (that's a future enhancement — buffering + re-check).
  async function* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = await runInputGuardrails(options);
    yield* opts.provider.stream({ ...options, messages });
  }

  return { generate, stream, provider: opts.provider };
}

export type Client = ReturnType<typeof createClient>;
