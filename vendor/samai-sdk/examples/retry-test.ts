import { withRetry } from "../src/resilience/index.js";
import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../src/types.js";

let attempts = 0;

const flakyProvider: Provider = {
  name: "openai",
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    attempts++;
    if (attempts < 3) {
      const err: any = new Error("Rate limited");
      err.status = 429;
      throw err;
    }
    return {
      model: options.model,
      text: "success",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      messages: options.messages,
      raw: null,
    };
  },
  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  },
};

const retryEvents: { attempt: number; delayMs: number }[] = [];

const resilient = withRetry(flakyProvider, {
  maxRetries: 3,
  initialDelayMs: 50, // small delays so the test runs fast
  maxDelayMs: 500,
  onRetry: (info) => retryEvents.push({ attempt: info.attempt, delayMs: info.delayMs }),
});

const start = Date.now();
const result = await resilient.generate({ model: "test", messages: [{ role: "user", content: "hi" }] });
const elapsed = Date.now() - start;

console.log("Result:", result.text);
console.log("Total provider calls:", attempts, "(expected 3 — 2 failures + 1 success)");
console.log("Retry events:", retryEvents);
console.log("Elapsed ms:", elapsed, "(should be roughly sum of the two backoff delays)");

if (attempts !== 3) throw new Error("Expected exactly 3 calls");
if (retryEvents.length !== 2) throw new Error("Expected exactly 2 retry events");
if (result.text !== "success") throw new Error("Expected success after retries");
console.log("\n✅ withRetry recovered from transient 429s correctly");

// --- Now test non-retryable error fails immediately ---
attempts = 0;
const alwaysFatal: Provider = {
  name: "openai",
  async generate(): Promise<GenerateResult> {
    attempts++;
    const err: any = new Error("Invalid API key");
    err.status = 401; // not in the retryable set
    throw err;
  },
  async *stream(): AsyncIterable<StreamChunk> {},
};

const resilient2 = withRetry(alwaysFatal, { maxRetries: 3, initialDelayMs: 10 });
try {
  await resilient2.generate({ model: "test", messages: [] });
  console.log("FAILED: should have thrown");
} catch (err) {
  console.log("\n✅ Non-retryable 401 failed immediately after", attempts, "call(s) (expected 1)");
  if (attempts !== 1) throw new Error("Should not retry a 401");
}
