import { z } from "zod";
import {
  createClient,
  defineAgent,
  defineTool,
  runAgent,
  createMockProvider,
  withConcurrencyLimit,
  withRateLimit,
} from "../src/index.js";
import type { Provider, GenerateOptions, GenerateResult, StreamChunk } from "../src/types.js";

// ===========================================================================
// TEST 1 — createMockProvider() actually drives a real agent loop correctly:
// tool calls, sequential turns, and call-log inspection all work
// ===========================================================================
console.log("=== TEST 1: createMockProvider() drives a real agent run ===");

const getWeather = defineTool({
  name: "get_weather",
  description: "Get the weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `18°C and cloudy in ${city}`,
});

const mock = createMockProvider({
  responses: [
    { toolCalls: [{ toolName: "get_weather", args: { city: "Tokyo" } }] },
    { text: "It's 18°C and cloudy in Tokyo." },
  ],
});

const client = createClient({ provider: mock });
const agent = defineAgent({ name: "weather_agent", instructions: "Answer weather questions.", model: "gpt-4o", tools: [getWeather] });

const result = await runAgent(client, agent, "What's the weather in Tokyo?");

console.log(`  mock.calls.length: ${mock.calls.length} (expected 2)`);
if (mock.calls.length !== 2) throw new Error("Expected exactly 2 calls to the mock provider (tool-call turn + final-answer turn)");

console.log(`  result.output: "${result.output}"`);
if (result.output !== "It's 18°C and cloudy in Tokyo.") throw new Error("Wrong final output");

const secondCallMessages = mock.calls[1].messages;
const hasToolResult = secondCallMessages.some(
  (m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "tool-result" && p.result === "18°C and cloudy in Tokyo")
);
console.log(`  second call's messages include the real tool result: ${hasToolResult}`);
if (!hasToolResult) throw new Error("The mock provider's call log should show the actual tool execution result feeding into turn 2");

// reset() lets one mock instance be reused across test cases
mock.reset();
const callsAfterReset: number = mock.calls.length;
console.log(`  after reset(): calls.length = ${callsAfterReset} (expected 0)`);
if (callsAfterReset !== 0) throw new Error("reset() should clear the call log");

const result2 = await runAgent(client, agent, "What's the weather in Paris?");
console.log(`  after reset(), a fresh run works again: "${result2.output}"`);
if (result2.output !== "It's 18°C and cloudy in Tokyo.") throw new Error("Reused mock provider (after reset) should behave the same as fresh");

// error simulation
const erroringMock = createMockProvider({ responses: [{ error: new Error("simulated provider outage") }] });
const erroringClient = createClient({ provider: erroringMock });
let threwSimulatedError = false;
try {
  await runAgent(erroringClient, agent, "hi");
} catch (err) {
  threwSimulatedError = err instanceof Error && /simulated provider outage/.test((err as any).cause?.message ?? String(err));
}
console.log(`  MockTurn.error propagates as a real failure: ${threwSimulatedError}`);
if (!threwSimulatedError) throw new Error("A MockTurn.error should surface as a real run failure");

console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — withConcurrencyLimit(): never exceeds maxConcurrent in-flight calls
// ===========================================================================
console.log("=== TEST 2: withConcurrencyLimit() caps real concurrent in-flight calls ===");

let inFlight = 0;
let maxObservedInFlight = 0;
const slowProvider: Provider = {
  name: "openai",
  async generate(): Promise<GenerateResult> {
    inFlight++;
    maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 40));
    inFlight--;
    return { model: "test", text: "ok", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, messages: [], raw: null };
  },
  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error("not used");
  },
};

const limited = withConcurrencyLimit(slowProvider, { maxConcurrent: 2 });

// Fire 6 concurrent calls against a limit of 2.
await Promise.all(
  Array.from({ length: 6 }, () => limited.generate({ model: "test", messages: [{ role: "user", content: "hi" }] }))
);

console.log(`  maxObservedInFlight: ${maxObservedInFlight} (expected exactly 2)`);
if (maxObservedInFlight !== 2) throw new Error(`Concurrency limit was not respected — observed ${maxObservedInFlight} in flight, expected 2`);
if (inFlight !== 0) throw new Error("All calls should have completed and released their slot");

console.log("✅ TEST 2 passed\n");

// ===========================================================================
// TEST 3 — withRateLimit(): queues calls beyond the window instead of erroring,
// and genuinely spaces them out in wall-clock time
// ===========================================================================
console.log("=== TEST 3: withRateLimit() spaces out calls beyond the limit ===");

const fastProvider: Provider = {
  name: "openai",
  async generate(): Promise<GenerateResult> {
    return { model: "test", text: "ok", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, messages: [], raw: null };
  },
  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error("not used");
  },
};

// 2 requests per 100ms window — the 3rd call must wait for the window to refill.
const rateLimited = withRateLimit(fastProvider, { maxRequests: 2, intervalMs: 100 });

const t0 = Date.now();
await rateLimited.generate({ model: "test", messages: [{ role: "user", content: "1" }] });
await rateLimited.generate({ model: "test", messages: [{ role: "user", content: "2" }] });
const afterTwoFree = Date.now() - t0;
console.log(`  first 2 calls (within budget) took ${afterTwoFree}ms (expected fast, <50ms)`);
if (afterTwoFree > 50) throw new Error("First 2 calls should not have been throttled at all");

await rateLimited.generate({ model: "test", messages: [{ role: "user", content: "3" }] });
const afterThird = Date.now() - t0;
console.log(`  3rd call (over budget) took ${afterThird}ms total (expected to have waited, >=50ms)`);
if (afterThird < 50) throw new Error("3rd call should have been throttled until the token bucket refilled");

console.log("✅ TEST 3 passed\n");

console.log("🎉 All testing-utilities/resilience-limit tests passed");
