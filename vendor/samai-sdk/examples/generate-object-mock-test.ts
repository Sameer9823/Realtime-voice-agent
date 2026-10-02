import { z } from "zod";
import { createClient, generateObject } from "../src/index.js";
import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../src/types.js";

let callCount = 0;

// A fake provider: first call returns malformed JSON (missing required field),
// second call returns valid JSON. Proves the repair loop actually re-prompts
// and recovers instead of just failing once.
const mockProvider: Provider = {
  name: "openai",
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    callCount++;
    const text =
      callCount === 1
        ? '```json\n{"summary": "Good product"}\n```' // missing `score` and `sentiment`
        : '```json\n{"summary": "Good product", "sentiment": "positive", "score": 4}\n```';

    return {
      model: options.model,
      text,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40 },
      messages: options.messages,
      raw: null,
    };
  },
  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  },
};

const client = createClient({ provider: mockProvider });

const schema = z.object({
  summary: z.string(),
  sentiment: z.enum(["positive", "negative", "mixed"]),
  score: z.number(),
});

const result = await generateObject(client, {
  model: "fake-model",
  schema,
  messages: [{ role: "user", content: "review this product" }],
});

console.log("Object:", result.object);
console.log("Attempts:", result.attempts, "(expected 2 — first attempt failed validation, second succeeded)");
console.log("Cumulative usage:", result.usage, "(expected totalTokens: 80 — summed across both attempts)");
console.log("Provider call count:", callCount);

if (result.attempts !== 2) throw new Error("Expected repair loop to take 2 attempts");
if (result.usage.totalTokens !== 80) throw new Error("Expected usage summed across attempts");
console.log("\n✅ generateObject repair loop verified working correctly");
