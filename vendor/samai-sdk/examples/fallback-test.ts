import { withFallback, createResilientProvider, AllProvidersFailedError } from "../src/resilience/index.js";
import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../src/types.js";

function makeProvider(name: "openai" | "anthropic" | "google", shouldFail: boolean): Provider {
  return {
    name,
    async generate(options: GenerateOptions): Promise<GenerateResult> {
      if (shouldFail) {
        const err: any = new Error(`${name} is down`);
        err.status = 503;
        throw err;
      }
      return {
        model: options.model,
        text: `response from ${name}`,
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        messages: options.messages,
        raw: null,
      };
    },
    async *stream(): AsyncIterable<StreamChunk> {
      if (shouldFail) throw new Error(`${name} is down`);
      yield { type: "text-delta", textDelta: `hi from ${name}` };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    },
  };
}

// --- Test 1: first provider fails, second succeeds ---
const fallbackEvents: string[] = [];
const chain = withFallback([makeProvider("anthropic", true), makeProvider("openai", false)], {
  onFallback: (info) => fallbackEvents.push(`${info.failedProvider} -> ${info.nextProvider}`),
});

const result = await chain.generate({ model: "test", messages: [{ role: "user", content: "hi" }] });
console.log("Result:", result.text, "(expected: response from openai)");
console.log("Fallback events:", fallbackEvents);
if (result.text !== "response from openai") throw new Error("Expected fallback to openai to succeed");
if (fallbackEvents.length !== 1) throw new Error("Expected exactly 1 fallback event");
console.log("✅ Fallback to second provider worked\n");

// --- Test 2: all providers fail ---
const allFail = withFallback([makeProvider("anthropic", true), makeProvider("openai", true)]);
try {
  await allFail.generate({ model: "test", messages: [] });
  console.log("FAILED: should have thrown");
} catch (err) {
  if (err instanceof AllProvidersFailedError) {
    console.log("✅ Correctly threw AllProvidersFailedError when every provider fails");
    console.log("  message:", err.message);
  } else {
    throw err;
  }
}

// --- Test 3: createResilientProvider combines retry + fallback ---
let anthropicCalls = 0;
const flakyAnthropic: Provider = {
  name: "anthropic",
  async generate(): Promise<GenerateResult> {
    anthropicCalls++;
    const err: any = new Error("overloaded");
    err.status = 503;
    throw err; // always fails, to prove it exhausts retries THEN falls through
  },
  async *stream(): AsyncIterable<StreamChunk> {},
};

const resilient = createResilientProvider([flakyAnthropic, makeProvider("openai", false)], {
  retry: { maxRetries: 2, initialDelayMs: 10 },
});

const result2 = await resilient.generate({ model: "test", messages: [{ role: "user", content: "hi" }] });
console.log("\nResilient result:", result2.text, "(expected: response from openai)");
console.log("Anthropic call attempts before fallback:", anthropicCalls, "(expected 3 = 1 + 2 retries)");
if (anthropicCalls !== 3) throw new Error("Expected retries to exhaust before falling through");
if (result2.text !== "response from openai") throw new Error("Expected eventual fallback success");
console.log("✅ createResilientProvider correctly retried then fell through to the working provider");
