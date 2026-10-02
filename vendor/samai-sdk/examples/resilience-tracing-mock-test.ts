import {
  createClient,
  defineAgent,
  runAgent,
  runAgentStream,
  withRetry,
  withFallback,
  withTimeout,
} from "../src/index.js";
import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../src/types.js";

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function okStream(text: string): Provider["stream"] {
  return async function* (): AsyncIterable<StreamChunk> {
    yield { type: "text-delta", textDelta: text };
    yield { type: "finish", finishReason: "stop", usage: USAGE };
  };
}

async function drain(gen: ReturnType<typeof runAgentStream>) {
  const events = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, result: step.value };
}

// ===========================================================================
// TEST 1 — a retried call shows up in both the trace and the event stream
// ===========================================================================
console.log("=== TEST 1: retries are traced ===");

let attempts1 = 0;
const flaky: Provider = {
  name: "openai",
  async generate(): Promise<GenerateResult> {
    throw new Error("not used");
  },
  stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    attempts1++;
    if (attempts1 <= 2) {
      const err: any = new Error("503 Service Unavailable");
      err.status = 503;
      throw err;
    }
    yield* okStream("Recovered after retries.")(options);
  },
};

const retryProvider = withRetry(flaky, { maxRetries: 3, initialDelayMs: 5, maxDelayMs: 20 });
const retryClient = createClient({ provider: retryProvider });
const retryAgent = defineAgent({ name: "retry_agent", instructions: "Reply briefly.", model: "gpt-4o" });

const { events: retryEvents, result: retryResult } = await drain(
  runAgentStream(retryClient, retryAgent, "hello")
);

const retryAgentEvents = retryEvents.filter((e) => e.type === "retry-attempted");
const retryTraceEvents = retryResult.trace.events.filter((e) => e.type === "retry");

console.log(`  attempts made: ${attempts1} (expected 3)`);
console.log(`  retry-attempted AgentEvents: ${retryAgentEvents.length} (expected 2)`);
console.log(`  "retry" trace events: ${retryTraceEvents.length} (expected 2)`);
console.log(`  final output: "${retryResult.output}"`);

if (attempts1 !== 3) throw new Error("Expected exactly 3 attempts (2 failures + 1 success)");
if (retryAgentEvents.length !== 2) throw new Error("Expected 2 retry-attempted AgentEvents");
if (retryTraceEvents.length !== 2) throw new Error("Expected 2 'retry' events in trace.events");
if (retryResult.output !== "Recovered after retries.") throw new Error("Wrong final output");
console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — a fallback to a second provider shows up in both the trace and events
// ===========================================================================
console.log("=== TEST 2: fallbacks are traced ===");

const alwaysFails: Provider = {
  name: "openai",
  async generate(): Promise<GenerateResult> {
    throw new Error("not used");
  },
  stream: async function* (): AsyncIterable<StreamChunk> {
    throw new Error("openai is down");
    // eslint-disable-next-line no-unreachable
    yield { type: "finish", finishReason: "stop", usage: USAGE };
  },
};

const backupWorks: Provider = { name: "anthropic", async generate(): Promise<GenerateResult> {
  throw new Error("not used");
}, stream: okStream("Answered by the backup provider.") };

const fallbackProvider = withFallback([alwaysFails, backupWorks]);
const fallbackClient = createClient({ provider: fallbackProvider });
const fallbackAgent = defineAgent({ name: "fallback_agent", instructions: "Reply briefly.", model: "gpt-4o" });

const { events: fbEvents, result: fbResult } = await drain(
  runAgentStream(fallbackClient, fallbackAgent, "hello")
);

const fbAgentEvents = fbEvents.filter((e) => e.type === "fallback-triggered");
const fbTraceEvents = fbResult.trace.events.filter((e) => e.type === "fallback");

console.log(`  fallback-triggered AgentEvents: ${fbAgentEvents.length} (expected 1)`);
console.log(`  "fallback" trace events: ${fbTraceEvents.length} (expected 1)`);
console.log(`  final output: "${fbResult.output}"`);

if (fbAgentEvents.length !== 1) throw new Error("Expected 1 fallback-triggered AgentEvent");
if (fbTraceEvents.length !== 1) throw new Error("Expected 1 'fallback' event in trace.events");
if ((fbAgentEvents[0] as any).failedProvider !== "openai") throw new Error("Wrong failedProvider recorded");
if ((fbAgentEvents[0] as any).nextProvider !== "anthropic") throw new Error("Wrong nextProvider recorded");
if (fbResult.output !== "Answered by the backup provider.") throw new Error("Wrong final output");
console.log("✅ TEST 2 passed\n");

// ===========================================================================
// TEST 3 — a timeout (recovered via retry) shows up in the trace as its own event
// ===========================================================================
console.log("=== TEST 3: timeouts are traced ===");

let attempts3 = 0;
const hangsOnce: Provider = {
  name: "openai",
  async generate(): Promise<GenerateResult> {
    throw new Error("not used");
  },
  stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    attempts3++;
    if (attempts3 === 1) {
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    yield* okStream("Answered after the hung first attempt timed out.")(options);
  },
};

const resilientProvider = withRetry(withTimeout(hangsOnce, { timeoutMs: 50 }), {
  maxRetries: 1,
  initialDelayMs: 5,
});
const timeoutClient = createClient({ provider: resilientProvider });
const timeoutAgent = defineAgent({ name: "timeout_agent", instructions: "Reply briefly.", model: "gpt-4o" });

const { events: toEvents, result: toResult } = await drain(
  runAgentStream(timeoutClient, timeoutAgent, "hello")
);

const toAgentEvents = toEvents.filter((e) => e.type === "timeout-occurred");
const toTraceEvents = toResult.trace.events.filter((e) => e.type === "timeout");

console.log(`  timeout-occurred AgentEvents: ${toAgentEvents.length} (expected 1)`);
console.log(`  "timeout" trace events: ${toTraceEvents.length} (expected 1)`);
console.log(`  final output: "${toResult.output}"`);

if (toAgentEvents.length !== 1) throw new Error("Expected 1 timeout-occurred AgentEvent");
if (toTraceEvents.length !== 1) throw new Error("Expected 1 'timeout' event in trace.events");
if (toResult.output !== "Answered after the hung first attempt timed out.") {
  throw new Error("Wrong final output");
}
console.log("✅ TEST 3 passed\n");

console.log("🎉 All resilience-tracing tests passed");
