/** Turns text into embedding vectors — the thing you feed into a `VectorStore`. */
export interface EmbeddingProvider {
  /** Model name/id, surfaced for logging/tracing. */
  name: string;
  /** Embeds a batch of texts in one call where the underlying API supports it (cheaper, faster than one-by-one). */
  embed(texts: string[]): Promise<number[][]>;
}

export interface OpenAIEmbeddingsConfig {
  apiKey?: string;
  baseURL?: string;
  /** Default: "text-embedding-3-small" — cheap, fast, good default dimensionality (1536). */
  model?: string;
}

/**
 * Embeddings via the OpenAI API (`/v1/embeddings`) — also works against any OpenAI-compatible
 * embeddings endpoint (pass a different `baseURL`). Requires the optional `openai` peer
 * dependency, same as the `openai()` chat provider.
 */
export function openaiEmbeddings(config: OpenAIEmbeddingsConfig = {}): EmbeddingProvider {
  const model = config.model ?? "text-embedding-3-small";

  return {
    name: model,
    async embed(texts: string[]): Promise<number[][]> {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
      const response = await client.embeddings.create({ model, input: texts });
      return response.data
        .sort((a, b) => a.index - b.index) // API guarantees order matches input, but don't rely on it silently
        .map((d) => d.embedding);
    },
  };
}
