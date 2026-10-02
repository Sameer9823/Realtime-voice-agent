import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../types.js";

export interface FallbackOptions {
  /** Observability hook, called whenever a provider fails and we're about to try the next one. */
  onFallback?: (info: { failedProvider: string; nextProvider: string; error: unknown }) => void;
}

export class AllProvidersFailedError extends Error {
  constructor(public errors: { provider: string; error: unknown }[]) {
    super(
      `All providers failed: ${errors.map((e) => `${e.provider} (${e.error instanceof Error ? e.error.message : String(e.error)})`).join("; ")}`
    );
    this.name = "AllProvidersFailedError";
  }
}

/**
 * Wraps an ordered list of providers into one Provider. On failure, falls through
 * to the next provider in the list — e.g. `withFallback([anthropic(), openai()])`
 * tries Claude first and automatically retries the same request on GPT if Claude
 * errors out or times out.
 *
 * For `stream()`, fallback only applies before the first chunk has been yielded —
 * once a provider has started streaming output to the caller, a later failure in
 * that stream is surfaced as-is rather than silently switching providers mid-stream.
 */
export function withFallback(providers: Provider[], options: FallbackOptions = {}): Provider {
  if (providers.length === 0) {
    throw new Error("withFallback requires at least one provider");
  }

  async function generate(genOptions: GenerateOptions): Promise<GenerateResult> {
    const errors: { provider: string; error: unknown }[] = [];

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      try {
        return await provider.generate(genOptions);
      } catch (err) {
        errors.push({ provider: provider.name, error: err });
        const next = providers[i + 1];
        if (next) {
          const info = { failedProvider: provider.name, nextProvider: next.name, error: err };
          options.onFallback?.(info);
          genOptions.onFallback?.(info);
        }
      }
    }

    throw new AllProvidersFailedError(errors);
  }

  async function* stream(genOptions: GenerateOptions): AsyncIterable<StreamChunk> {
    const errors: { provider: string; error: unknown }[] = [];

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      let anyYielded = false;
      try {
        for await (const chunk of provider.stream(genOptions)) {
          anyYielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (anyYielded) throw err; // already streamed to the caller — can't switch providers now
        errors.push({ provider: provider.name, error: err });
        const next = providers[i + 1];
        if (next) {
          const info = { failedProvider: provider.name, nextProvider: next.name, error: err };
          options.onFallback?.(info);
          genOptions.onFallback?.(info);
        }
      }
    }

    throw new AllProvidersFailedError(errors);
  }

  return { name: providers[0].name, generate, stream };
}
