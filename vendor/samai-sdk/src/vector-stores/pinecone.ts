import type { VectorQueryOptions, VectorQueryResult, VectorRecord, VectorStore } from "../vector-store.js";

export interface PineconeVectorStoreConfig {
  /** Falls back to `PINECONE_API_KEY` if not passed. */
  apiKey?: string;
  /** Your index's host URL, e.g. "https://my-index-abc123.svc.us-east-1-aws.pinecone.io" (from the Pinecone console). */
  indexHost: string;
  /** Optional namespace within the index. */
  namespace?: string;
}

/**
 * Pinecone-backed `VectorStore` — talks directly to Pinecone's REST API over `fetch`, so it
 * doesn't need the `@pinecone-database/pinecone` SDK as a peer dependency. Get an API key and
 * index host at https://app.pinecone.io.
 */
export class PineconeVectorStore implements VectorStore {
  private apiKey: string;
  private indexHost: string;
  private namespace?: string;

  constructor(config: PineconeVectorStoreConfig) {
    const apiKey = config.apiKey ?? process.env.PINECONE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "PineconeVectorStore requires an apiKey (pass it directly, or set PINECONE_API_KEY)."
      );
    }
    this.apiKey = apiKey;
    this.indexHost = config.indexHost.replace(/\/$/, "");
    this.namespace = config.namespace;
  }

  private headers() {
    return {
      "Api-Key": this.apiKey,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": "2024-10",
    };
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    const res = await fetch(`${this.indexHost}/vectors/upsert`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        vectors: records.map((r) => ({ id: r.id, values: r.vector, metadata: r.metadata ?? {} })),
        namespace: this.namespace,
      }),
    });
    if (!res.ok) {
      throw new Error(`Pinecone upsert failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => "")}`);
    }
  }

  async query(vector: number[], options: VectorQueryOptions = {}): Promise<VectorQueryResult[]> {
    const res = await fetch(`${this.indexHost}/query`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        vector,
        topK: options.topK ?? 5,
        namespace: this.namespace,
        includeMetadata: true,
        filter: options.filter,
      }),
    });
    if (!res.ok) {
      throw new Error(`Pinecone query failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => "")}`);
    }
    const data = (await res.json()) as { matches?: { id: string; score: number; metadata?: Record<string, unknown> }[] };
    return (data.matches ?? []).map((m) => ({ id: m.id, score: m.score, metadata: m.metadata }));
  }

  async delete(ids: string[]): Promise<void> {
    const res = await fetch(`${this.indexHost}/vectors/delete`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ids, namespace: this.namespace }),
    });
    if (!res.ok) {
      throw new Error(`Pinecone delete failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => "")}`);
    }
  }
}
