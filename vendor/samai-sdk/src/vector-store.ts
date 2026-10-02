export interface VectorRecord {
  id: string;
  /** The embedding vector — must match the dimensionality your embedding provider produces. */
  vector: number[];
  /** Arbitrary metadata carried alongside the vector, returned unchanged on query (e.g. source text, doc URL). */
  metadata?: Record<string, unknown>;
}

export interface VectorQueryResult {
  id: string;
  /** Cosine similarity, 1 = identical direction, 0 = orthogonal, -1 = opposite. Higher is more relevant. */
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorQueryOptions {
  /** Max results to return. Default: 5. */
  topK?: number;
  /** Only return records whose metadata matches every key/value pair given here (simple equality filter). */
  filter?: Record<string, unknown>;
}

/**
 * Storage abstraction for embeddings — deliberately the same shape as `SessionStore`
 * (a handful of methods, swap implementations without touching call sites). Implement this
 * to back retrieval with Pinecone, pgvector, Qdrant, Weaviate, etc.
 */
export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  query(vector: number[], options?: VectorQueryOptions): Promise<VectorQueryResult[]>;
  delete(ids: string[]): Promise<void>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function matchesFilter(metadata: Record<string, unknown> | undefined, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true;
  if (!metadata) return false;
  return Object.entries(filter).every(([key, value]) => metadata[key] === value);
}

/**
 * A dependency-free, in-process vector store — brute-force cosine similarity over whatever's
 * currently held in memory. No setup, no API key, good for prototyping, tests, and small
 * corpora (a few thousand vectors is fine; beyond that, reach for a real vector DB via a
 * custom `VectorStore`, or `PineconeVectorStore`).
 */
export class InMemoryVectorStore implements VectorStore {
  private records = new Map<string, VectorRecord>();

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) this.records.set(record.id, record);
  }

  async query(vector: number[], options: VectorQueryOptions = {}): Promise<VectorQueryResult[]> {
    const topK = options.topK ?? 5;
    const scored: VectorQueryResult[] = [];
    for (const record of this.records.values()) {
      if (!matchesFilter(record.metadata, options.filter)) continue;
      scored.push({ id: record.id, score: cosineSimilarity(vector, record.vector), metadata: record.metadata });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }

  /** Number of vectors currently stored — handy in tests/debugging. */
  get size(): number {
    return this.records.size;
  }
}
