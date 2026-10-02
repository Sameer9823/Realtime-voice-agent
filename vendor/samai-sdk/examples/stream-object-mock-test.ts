import { z } from "zod";
import { createClient, streamObject } from "../src/index.js";
import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../src/types.js";

// A fake provider that dribbles out a JSON object one token at a time,
// simulating what a real streaming API does. Proves partialObjectStream
// emits progressively-more-complete objects, and that `object`/`usage`
// resolve correctly once the stream finishes.
const fullJson = '{"summary": "Good product", "sentiment": "positive", "score": 4}';
const tokens = fullJson.match(/.{1,6}/g) ?? [];

const mockProvider: Provider = {
  name: "openai",
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    throw new Error("not used in this test");
  },
  async *stream(): AsyncIterable<StreamChunk> {
    for (const token of tokens) {
      yield { type: "text-delta", textDelta: token };
    }
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 15, outputTokens: 25, totalTokens: 40 } };
  },
};

const client = createClient({ provider: mockProvider });

const schema = z.object({
  summary: z.string(),
  sentiment: z.enum(["positive", "negative", "mixed"]),
  score: z.number(),
});

const { partialObjectStream, object, usage } = streamObject(client, {
  model: "fake-model",
  schema,
  messages: [{ role: "user", content: "review this product" }],
});

let partialCount = 0;
let lastPartial: unknown;
for await (const partial of partialObjectStream) {
  partialCount++;
  lastPartial = partial;
  console.log(`partial #${partialCount}:`, partial);
}

const finalObject = await object;
const finalUsage = await usage;

console.log("\nFinal object:", finalObject);
console.log("Final usage:", finalUsage);
console.log("Partial emits:", partialCount);

if (partialCount < 2) throw new Error("Expected multiple partial emits as tokens streamed in");
if (finalObject.score !== 4 || finalObject.sentiment !== "positive") {
  throw new Error("Final object did not match expected schema-validated result");
}
if (finalUsage.totalTokens !== 40) throw new Error("Expected usage to come from the stream's finish chunk");
if (typeof lastPartial === "object" && lastPartial && "score" in lastPartial) {
  console.log("Last partial already had 'score' filled in, as expected near the end of the stream");
}

console.log("\n✅ streamObject partial streaming + final validation verified working correctly");
