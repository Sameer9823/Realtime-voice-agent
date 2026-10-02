import { InMemoryVectorStore, createRetrievalTool, embedChunks } from "../src/index.js";
import type { EmbeddingProvider } from "../src/embeddings.js";

// ===========================================================================
// TEST 1 — InMemoryVectorStore: cosine similarity actually ranks correctly
// ===========================================================================
console.log("=== TEST 1: InMemoryVectorStore ranks by real cosine similarity ===");

const store = new InMemoryVectorStore();

// Hand-crafted vectors where the "closeness" is unambiguous by construction —
// no embedding model needed to verify the similarity math itself is correct.
await store.upsert([
  { id: "a", vector: [1, 0, 0], metadata: { text: "points along x" } },
  { id: "b", vector: [0.99, 0.1, 0], metadata: { text: "almost x, slightly y" } },
  { id: "c", vector: [0, 1, 0], metadata: { text: "points along y" } },
  { id: "d", vector: [-1, 0, 0], metadata: { text: "opposite of x" } },
]);

console.log(`  store.size: ${store.size} (expected 4)`);
if (store.size !== 4) throw new Error("Expected 4 vectors stored");

const results = await store.query([1, 0, 0], { topK: 3 });
console.log(`  ranking: ${results.map((r) => r.id).join(" > ")} (expected a > b > c)`);
if (results.map((r) => r.id).join(",") !== "a,b,c") throw new Error("Ranking by cosine similarity is wrong");
if (Math.abs(results[0].score - 1) > 1e-9) throw new Error("Identical-direction vector should score exactly 1");
if (results.find((r) => r.id === "d")) throw new Error("topK: 3 should have excluded the opposite vector 'd'");

// Metadata filtering
await store.upsert([{ id: "e", vector: [1, 0, 0], metadata: { text: "x again, different tenant", tenant: "acme" } }]);
const filtered = await store.query([1, 0, 0], { topK: 10, filter: { tenant: "acme" } });
console.log(`  filter: { tenant: "acme" } returns only: ${filtered.map((r) => r.id).join(",")} (expected e)`);
if (filtered.length !== 1 || filtered[0].id !== "e") throw new Error("Metadata filter did not isolate the right record");

// delete()
await store.delete(["a"]);
console.log(`  after delete(['a']), size: ${store.size} (expected 4)`);
if (store.size !== 4) throw new Error("delete() did not remove the record");
const afterDelete = await store.query([1, 0, 0], { topK: 10 });
if (afterDelete.find((r) => r.id === "a")) throw new Error("Deleted record still returned by query()");

console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — createRetrievalTool() end-to-end: embed query -> search -> return chunks
// (uses a deterministic FAKE embedding provider, injected the same way a real
//  `openaiEmbeddings()` provider would be — this is the supported extension point,
//  not a reimplementation of the tool's logic.)
// ===========================================================================
console.log("=== TEST 2: createRetrievalTool() end-to-end ===");

// A tiny deterministic "embedding" for testing: bag-of-words presence vector over a fixed
// vocabulary. Not a real embedding model, but it makes the *retrieval tool's wiring*
// (embed -> query -> shape results) verifiable without a network call.
const VOCAB = ["refund", "billing", "shipping", "password", "reset"];
const fakeEmbeddings: EmbeddingProvider = {
  name: "fake-bow-embedder",
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      return VOCAB.map((word) => (lower.includes(word) ? 1 : 0));
    });
  },
};

const kbStore = new InMemoryVectorStore();
const records = await embedChunks(fakeEmbeddings, [
  { id: "doc-1", text: "How to request a refund for a billing charge." },
  { id: "doc-2", text: "How to reset your password." },
  { id: "doc-3", text: "Shipping times for international orders." },
]);
await kbStore.upsert(records);

const tool = createRetrievalTool({ embeddings: fakeEmbeddings, store: kbStore, options: { topK: 2 } });

console.log(`  tool.name: "${tool.name}" (expected "retrieve_knowledge")`);
if (tool.name !== "retrieve_knowledge") throw new Error("Default tool name is wrong");

const result = await tool.execute({ query: "I want a refund on my billing" });
console.log(`  top result id: "${result[0].id}" (expected "doc-1")`);
console.log(`  top result text: "${result[0].text}"`);
if (result[0].id !== "doc-1") throw new Error("Retrieval did not surface the most relevant chunk first");
if (result[0].text !== "How to request a refund for a billing charge.") {
  throw new Error("embedChunks() did not preserve original text in metadata for the tool to return");
}
if (result.length > 2) throw new Error("topK: 2 was not respected");

const passwordResult = await tool.execute({ query: "how do I reset my password" });
console.log(`  password query top result: "${passwordResult[0].id}" (expected "doc-2")`);
if (passwordResult[0].id !== "doc-2") throw new Error("Retrieval ranking is wrong for the password query");

console.log("✅ TEST 2 passed\n");

console.log("🎉 All RAG (vector store + retrieval tool) tests passed");
