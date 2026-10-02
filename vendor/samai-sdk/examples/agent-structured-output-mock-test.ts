import { z } from "zod";
import { createClient, defineAgent, runAgent } from "../src/index.js";
import type { GenerateOptions, Provider, StreamChunk } from "../src/types.js";

// First call returns invalid JSON (missing `score`), second call (after the
// repair nudge the run loop appends) returns valid JSON. Proves an Agent's
// outputSchema is validated + repaired inside the agent loop itself, not
// just in the standalone generateObject() helper.
let callCount = 0;

const mockProvider: Provider = {
  name: "openai",
  async generate() {
    throw new Error("not used");
  },
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    callCount++;
    const text = callCount === 1 ? '{"summary": "Great trip"}' : '{"summary": "Great trip", "score": 9}';
    for (const t of text.match(/.{1,10}/g) ?? []) {
      yield { type: "text-delta", textDelta: t };
    }
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
  },
};

const client = createClient({ provider: mockProvider });

const reviewAgent = defineAgent({
  name: "review_agent",
  instructions: "Summarize trip reviews as structured data.",
  model: "fake-model",
  outputSchema: z.object({ summary: z.string(), score: z.number() }),
});

const result = await runAgent(client, reviewAgent, "Review: had a great trip, would give it a 9/10.");

console.log("Output:", result.output);
console.log("Provider call count:", callCount, "(expected 2 — first attempt failed validation, got repaired)");

if (result.output.score !== 9) throw new Error("Expected repaired structured output with score: 9");
if (callCount !== 2) throw new Error("Expected the agent loop to self-repair invalid structured output");

console.log("✅ Agent structured-output + repair verified working correctly");
