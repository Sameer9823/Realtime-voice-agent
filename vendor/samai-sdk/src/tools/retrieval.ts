import { z } from "zod";
import { defineTool, type ToolDefinition } from "../types.js";
import type { VectorStore } from "../vector-store.js";
import type { EmbeddingProvider } from "../embeddings.js";

export interface RetrievalToolOptions {
  /** Tool name the model sees. Default: "retrieve_knowledge". */
  name?: string;
  /** Tool description shown to the model — customize this to describe what's actually in your store. */
  description?: string;
  /** How many chunks to return per query. Default: 5. */
  topK?: number;
  /** Applied to every query — restrict retrieval to a subset of your store (e.g. `{ tenantId: "acme" }`). */
  filter?: Record<string, unknown>;
  /** Which metadata field holds the chunk's text, if you want it echoed back directly. Default: "text". */
  textField?: string;
}

export interface RetrievedChunk {
  id: string;
  score: number;
  text: string | undefined;
  metadata: Record<string, unknown> | undefined;
}

const retrievalArgs = z.object({
  query: z.string().min(1).describe("What to search for in the knowledge base"),
});

/**
 * Wires an `EmbeddingProvider` + `VectorStore` into a ready-to-use tool: the model calls it
 * with a natural-language query, the tool embeds that query and returns the closest chunks
 * by cosine similarity. This is the whole RAG loop as one tool — embed → search → return.
 *
 * Usage:
 *   const store = new InMemoryVectorStore();
 *   await store.upsert(await embedDocuments(store, embeddings, chunks));
 *
 *   const agent = defineAgent({
 *     name: "support_agent",
 *     instructions: "Use retrieve_knowledge to ground answers in the docs before replying.",
 *     model: "claude-sonnet-4-6",
 *     tools: [createRetrievalTool({ embeddings, store })],
 *   });
 */
export function createRetrievalTool(config: {
  embeddings: EmbeddingProvider;
  store: VectorStore;
  options?: RetrievalToolOptions;
}): ToolDefinition<{ query: string }, RetrievedChunk[]> {
  const opts = config.options ?? {};
  const textField = opts.textField ?? "text";

  return defineTool({
    name: opts.name ?? "retrieve_knowledge",
    description:
      opts.description ??
      "Search the knowledge base for information relevant to a query. Returns the most relevant chunks, ranked by relevance.",
    parameters: retrievalArgs,
    execute: async ({ query }) => {
      const [vector] = await config.embeddings.embed([query]);
      const results = await config.store.query(vector, { topK: opts.topK, filter: opts.filter });
      return results.map((r) => ({
        id: r.id,
        score: r.score,
        text: r.metadata?.[textField] as string | undefined,
        metadata: r.metadata,
      }));
    },
  });
}

/**
 * Convenience helper for the ingestion side: embeds a batch of text chunks and returns
 * `VectorRecord`s ready for `store.upsert()`, with the original text kept in metadata (under
 * `textField`) so `createRetrievalTool()` can return it directly without a second lookup.
 *
 *   const chunks = splitMyDocsIntoChunks(rawText); // your own chunking logic
 *   const records = await embedChunks(embeddings, chunks.map((text, i) => ({ id: `doc-${i}`, text })));
 *   await store.upsert(records);
 */
export async function embedChunks(
  embeddings: EmbeddingProvider,
  chunks: { id: string; text: string; metadata?: Record<string, unknown> }[],
  textField = "text"
) {
  const vectors = await embeddings.embed(chunks.map((c) => c.text));
  return chunks.map((chunk, i) => ({
    id: chunk.id,
    vector: vectors[i],
    metadata: { ...chunk.metadata, [textField]: chunk.text },
  }));
}
