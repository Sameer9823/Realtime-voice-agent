import { z } from "zod";
import { createClient, generateObject, GenerateObjectError } from "../src/index.js";
import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../src/types.js";

// Always returns garbage — should exhaust attempts and throw a clear error.
const alwaysBadProvider: Provider = {
  name: "openai",
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    return {
      model: options.model,
      text: "not json at all, sorry",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      messages: options.messages,
      raw: null,
    };
  },
  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  },
};

const client = createClient({ provider: alwaysBadProvider });
const schema = z.object({ x: z.number() });

try {
  await generateObject(client, {
    model: "fake-model",
    schema,
    messages: [{ role: "user", content: "give me json" }],
    maxRepairAttempts: 2,
  });
  console.log("FAILED: should have thrown");
} catch (err) {
  if (err instanceof GenerateObjectError) {
    console.log("✅ Correctly threw GenerateObjectError");
    console.log("  attempts:", err.attempts, "(expected 3 = 1 initial + 2 repairs)");
    console.log("  message:", err.message);
  } else {
    console.log("FAILED: wrong error type", err);
  }
}
