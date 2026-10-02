import { z } from "zod";
import {
  createClient,
  defineAgent,
  runAgent,
  runAgentStream,
  createSession,
  InMemorySessionStore,
  AgentRunError,
  HandoffLoopError,
} from "../src/index.js";
import type { GenerateOptions, Provider, StreamChunk } from "../src/types.js";

// ---------------------------------------------------------------------------
// A scripted mock provider. Its responses depend only on which agent
// ("system" prompt) is being called and what's already in the message
// history, so we can deterministically exercise: tool calls, handoffs,
// handoff-loop prevention, and session continuity — with zero network calls.
// ---------------------------------------------------------------------------

function textDeltaChunks(text: string): StreamChunk[] {
  return text.match(/.{1,8}/g)!.map((t) => ({ type: "text-delta", textDelta: t }));
}

function countToolResults(options: GenerateOptions, toolName: string): number {
  return options.messages.filter(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === "tool-result" && p.toolName === toolName)
  ).length;
}

const mockProvider: Provider = {
  name: "openai",
  async generate() {
    throw new Error("not used — agent runtime always calls stream()");
  },
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const system = options.system ?? "";

    // --- Router agent: always looks up the weather tool first, then hands off ---
    if (system.startsWith("ROUTER")) {
      const weatherToolCalled = countToolResults(options, "get_weather") > 0;

      if (!weatherToolCalled) {
        yield {
          type: "tool-call",
          toolCall: { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", args: { city: "Tokyo" } },
        };
        yield { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
        return;
      }

      // weather tool already ran — now hand off to the specialist
      yield {
        type: "tool-call",
        toolCall: {
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "handoff_to__specialist",
          args: { reason: "user needs packing advice, specialist handles that" },
        },
      };
      yield { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 } };
      return;
    }

    // --- Specialist agent: gives a final answer using the weather context it inherited ---
    if (system.startsWith("SPECIALIST")) {
      yield* textDeltaChunks("Pack a light jacket, it'll be 18C and cloudy in Tokyo.");
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 } };
      return;
    }

    // --- Loop-prone agents: A always hands off to B, B always hands off back to A ---
    if (system.startsWith("LOOP_A")) {
      yield {
        type: "tool-call",
        toolCall: { type: "tool-call", toolCallId: "call_a", toolName: "handoff_to__loop_b", args: { reason: "x" } },
      };
      yield { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
      return;
    }
    if (system.startsWith("LOOP_B")) {
      yield {
        type: "tool-call",
        toolCall: { type: "tool-call", toolCallId: "call_b", toolName: "handoff_to__loop_a", args: { reason: "y" } },
      };
      yield { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
      return;
    }

    // --- Memory-test agent: echoes back how many prior user turns it can see ---
    if (system.startsWith("MEMORY_AGENT")) {
      const userTurns = options.messages.filter((m) => m.role === "user").length;
      yield* textDeltaChunks(`I see ${userTurns} user turn(s) in history.`);
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
      return;
    }

    throw new Error(`mock provider: no script for system prompt: ${system.slice(0, 40)}`);
  },
};

const client = createClient({ provider: mockProvider });

const weatherTool = {
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }: { city: string }) => `18C and cloudy in ${city}`,
};

// ===========================================================================
// TEST 1 — tool calling + handoff, verified via event stream
// ===========================================================================
console.log("=== TEST 1: tool call -> handoff -> final answer from specialist ===");

const specialist = defineAgent({
  name: "specialist",
  instructions: "SPECIALIST: You give packing advice based on weather context already gathered.",
  model: "fake-model",
});

const router = defineAgent({
  name: "router",
  instructions: "ROUTER: You check weather then hand off to the specialist for packing advice.",
  model: "fake-model",
  tools: [weatherTool],
  handoffs: [specialist],
});

const seenEventTypes: string[] = [];
let finalResult;
{
  const gen = runAgentStream(client, router, "What should I pack for Tokyo?");
  let step = await gen.next();
  while (!step.done) {
    seenEventTypes.push(step.value.type);
    if (step.value.type === "tool-started") console.log("  tool-started:", step.value.toolName);
    if (step.value.type === "handoff-started") console.log("  handoff-started:", step.value.fromAgent, "->", step.value.toAgent);
    if (step.value.type === "run-completed") console.log("  run-completed. text:", JSON.stringify(step.value.text));
    step = await gen.next();
  }
  finalResult = step.value;
}

console.log("Final agent:", finalResult.finalAgent, "(expected: specialist)");
console.log("Trace agent path:", finalResult.trace.agentPath, "(expected: [router, specialist])");
console.log("Trace total usage:", finalResult.trace.totalUsage, "(expected totalTokens: 68 = 15+18+35)");

if (finalResult.finalAgent !== "specialist") throw new Error("Expected handoff to specialist to produce the final answer");
if (finalResult.trace.agentPath.join(",") !== "router,specialist") throw new Error("Trace agentPath incorrect");
if (finalResult.trace.totalUsage.totalTokens !== 68) throw new Error("Trace usage not summed correctly across handoff");
if (!seenEventTypes.includes("tool-started") || !seenEventTypes.includes("handoff-started")) {
  throw new Error("Expected both tool-started and handoff-started events");
}
console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — handoff loop prevention (A -> B -> A must be blocked)
// ===========================================================================
console.log("=== TEST 2: handoff loop prevention ===");

const loopA: any = defineAgent({ name: "loop_a", instructions: "LOOP_A", model: "fake-model" });
const loopB: any = defineAgent({ name: "loop_b", instructions: "LOOP_B", model: "fake-model" });
loopA.handoffs = [loopB];
loopB.handoffs = [loopA];

let caughtLoopError = false;
try {
  await runAgent(client, loopA, "trigger a loop");
} catch (err) {
  if (err instanceof AgentRunError && err.cause instanceof HandoffLoopError) {
    caughtLoopError = true;
    console.log("  Caught expected HandoffLoopError:", err.cause.message);
    console.log("  Trace path at failure:", err.trace.agentPath);
  } else {
    throw err;
  }
}

if (!caughtLoopError) throw new Error("Expected HandoffLoopError to be thrown for A -> B -> A");
console.log("✅ TEST 2 passed\n");

// ===========================================================================
// TEST 3 — session persistence across two separate runAgent() calls
// ===========================================================================
console.log("=== TEST 3: session persists conversation across separate runs ===");

const memoryAgent = defineAgent({
  name: "memory_agent",
  instructions: "MEMORY_AGENT: report how many user turns you can see.",
  model: "fake-model",
});

const session = createSession("test-session-1", new InMemorySessionStore());

const run1 = await runAgent(client, memoryAgent, "first message", { session });
console.log("  Run 1 output:", run1.text);

const run2 = await runAgent(client, memoryAgent, "second message", { session });
console.log("  Run 2 output:", run2.text);

if (!run1.text.includes("1 user turn")) throw new Error("Run 1 should have seen exactly 1 user turn");
if (!run2.text.includes("2 user turn")) throw new Error("Run 2 should have seen 2 user turns via session memory");

const persisted = await session.getMessages();
console.log("  Persisted message count:", persisted.length, "(expected 4: 2 user + 2 assistant)");
if (persisted.length !== 4) throw new Error("Expected session to persist all 4 messages across both runs");

console.log("✅ TEST 3 passed\n");

console.log("🎉 All agent runtime tests passed");
