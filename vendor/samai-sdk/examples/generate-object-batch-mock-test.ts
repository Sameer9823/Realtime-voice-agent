import { z } from "zod";
import { createClient, generateObjectBatch, GenerateObjectBatchError } from "../src/index.js";
import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../src/types.js";

const schema = z.object({ id: z.string(), n: z.number() });

// ===========================================================================
// TEST 1 — partial failure isolation: one permanently-invalid item doesn't
// abort the batch, and results come back index-aligned with the inputs
// ===========================================================================
console.log("=== TEST 1: one bad item doesn't abort the batch, results stay index-aligned ===");

const items = ["a", "b", "c", "d", "e"];

function makeProvider(): Provider {
  return {
    name: "test",
    async generate(options: GenerateOptions): Promise<GenerateResult> {
      const originalUserText = String((options.messages.find((m) => m.role === "user")?.content as string) ?? "");
      const id = originalUserText.replace("item:", "");
      // "c" is permanently broken — never returns valid JSON, even after repair prompts.
      const text = id === "c" ? "not json at all" : JSON.stringify({ id, n: id.charCodeAt(0) });
      return {
        model: options.model,
        text,
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        messages: [...options.messages, { role: "assistant", content: text }],
        raw: null,
      };
    },
    async *stream(): AsyncIterable<StreamChunk> {
      throw new Error("not used");
    },
  };
}

const client = createClient({ provider: makeProvider() });

const settledOrder: string[] = [];
const batch = await generateObjectBatch(client, {
  items,
  concurrency: 2,
  buildOptions: (item) => ({
    model: "test-model",
    schema,
    maxRepairAttempts: 1,
    messages: [{ role: "user" as const, content: `item:${item}` }],
  }),
  onItemSettled: (r) => settledOrder.push(r.item as string),
});

console.log(`  results.length: ${batch.results.length} (expected 5)`);
if (batch.results.length !== 5) throw new Error("Expected one result per input item");

console.log(`  succeeded: ${batch.succeeded}, failed: ${batch.failed} (expected 4 / 1)`);
if (batch.succeeded !== 4 || batch.failed !== 1) throw new Error("Expected exactly item 'c' to fail");

const indexAligned = batch.results.every((r, i) => r.item === items[i] && r.index === i);
console.log(`  results are index-aligned with input order: ${indexAligned}`);
if (!indexAligned) throw new Error("results[i] must correspond to items[i] regardless of completion order");

const cResult = batch.results[2];
console.log(`  item 'c' status: ${cResult.status} (expected rejected)`);
if (cResult.status !== "rejected") throw new Error("Item 'c' should have failed validation permanently");
if (cResult.status === "rejected" && !/schema validation|not valid JSON/.test(cResult.error.message)) {
  throw new Error(`Unexpected error message for item 'c': ${cResult.error.message}`);
}

const aResult = batch.results[0];
if (aResult.status !== "fulfilled" || aResult.result.object.id !== "a") {
  throw new Error("Item 'a' should have succeeded with the right parsed object");
}

console.log(`  onItemSettled fired for all 5 items (in completion order): ${settledOrder.length === 5}`);
if (settledOrder.length !== 5) throw new Error("onItemSettled should fire once per item");

console.log(`  total usage summed across successful items: ${JSON.stringify(batch.usage)}`);
if (batch.usage.totalTokens !== 4 * 15) throw new Error("usage should sum the 4 successful calls' token usage (15 each)");

console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — throwOnAnyFailure: rejects with a GenerateObjectBatchError carrying
// the full per-item results, only after every item has settled
// ===========================================================================
console.log("=== TEST 2: throwOnAnyFailure surfaces a GenerateObjectBatchError with full results ===");

let threw: unknown;
try {
  await generateObjectBatch(client, {
    items,
    concurrency: 3,
    throwOnAnyFailure: true,
    buildOptions: (item) => ({
      model: "test-model",
      schema,
      maxRepairAttempts: 1,
      messages: [{ role: "user" as const, content: `item:${item}` }],
    }),
  });
} catch (err) {
  threw = err;
}

const isRightErrorType = threw instanceof GenerateObjectBatchError;
console.log(`  threw GenerateObjectBatchError: ${isRightErrorType}`);
if (!isRightErrorType) throw new Error("throwOnAnyFailure should throw a GenerateObjectBatchError");

const batchResult = (threw as GenerateObjectBatchError).batchResult;
console.log(`  error carries full batch result (5 results, 1 failed): ${batchResult.results.length === 5 && batchResult.failed === 1}`);
if (batchResult.results.length !== 5 || batchResult.failed !== 1) throw new Error("Error should carry the complete per-item breakdown");

console.log("✅ TEST 2 passed\n");

// ===========================================================================
// TEST 3 — concurrency is actually bounded (real wall-clock check, not just a
// call-count assertion)
// ===========================================================================
console.log("=== TEST 3: concurrency cap is respected under real timing ===");

let inFlight = 0;
let maxObservedInFlight = 0;
const slowProvider: Provider = {
  name: "test",
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    inFlight++;
    maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 30));
    inFlight--;
    return {
      model: options.model,
      text: JSON.stringify({ id: "x", n: 1 }),
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      messages: [],
      raw: null,
    };
  },
  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error("not used");
  },
};

const slowClient = createClient({ provider: slowProvider });
await generateObjectBatch(slowClient, {
  items: Array.from({ length: 8 }, (_, i) => i),
  concurrency: 3,
  buildOptions: (item) => ({
    model: "test-model",
    schema,
    messages: [{ role: "user" as const, content: `item:${item}` }],
  }),
});

console.log(`  maxObservedInFlight: ${maxObservedInFlight} (expected exactly 3)`);
if (maxObservedInFlight !== 3) throw new Error(`Expected concurrency capped at 3, observed ${maxObservedInFlight}`);

console.log("✅ TEST 3 passed\n");

console.log("🎉 All generateObjectBatch tests passed");
