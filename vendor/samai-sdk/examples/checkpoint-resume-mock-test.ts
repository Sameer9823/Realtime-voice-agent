import { z } from "zod";
import {
  createClient,
  defineAgent,
  defineTool,
  runAgent,
  resumeAgent,
  InMemoryCheckpointStore,
  FileCheckpointStore,
} from "../src/index.js";
import { CheckpointNotFoundError, AgentRunError } from "../src/run.js";
import { handoffToolName } from "../src/handoff.js";
import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../src/types.js";

function textStream(text: string): StreamChunk[] {
  return [{ type: "text-delta", textDelta: text }, { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } }];
}

// ===========================================================================
// TEST 1 — a genuine crash mid-run is recoverable: the tool call from before
// the crash is NOT re-executed on resume (proving real resumption, not a
// disguised restart-from-scratch)
// ===========================================================================
console.log("=== TEST 1: resume after a crash — no duplicate tool execution ===");

let toolExecutionCount = 0;
const getNumber = defineTool({
  name: "get_number",
  description: "Returns a number",
  parameters: z.object({}),
  execute: async () => {
    toolExecutionCount++;
    return 42;
  },
});

let crashyCallCount = 0;
const crashyProvider: Provider = {
  name: "openai",
  async generate(): Promise<GenerateResult> {
    throw new Error("not used");
  },
  stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    crashyCallCount++;
    if (crashyCallCount === 1) {
      // Turn 1: call the tool.
      yield {
        type: "tool-call",
        toolCall: { type: "tool-call", toolCallId: "call_1", toolName: "get_number", args: {} },
      };
      yield { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
      return;
    }
    // Turn 2 (post-tool): simulate a hard crash — an error that isn't caught anywhere
    // upstream, the same as a process dying mid-request.
    throw new Error("simulated crash: process died mid-request");
  },
};

const checkpointStore = new InMemoryCheckpointStore();
const client1 = createClient({ provider: crashyProvider });
const agent = defineAgent({
  name: "worker",
  instructions: "Use get_number, then report the result.",
  model: "gpt-4o",
  tools: [getNumber],
});

let crashed = false;
try {
  await runAgent(client1, agent, "What's the number?", { checkpoint: { store: checkpointStore, runId: "run-1" } });
} catch (err) {
  crashed = true;
  console.log(`  run threw as expected: ${err instanceof AgentRunError}`);
  if (!(err instanceof AgentRunError)) throw new Error("Expected the simulated crash to surface as AgentRunError");
}
if (!crashed) throw new Error("Expected the run to crash on turn 2");

const savedCheckpoint = await checkpointStore.load("run-1");
console.log(`  checkpoint was saved after turn 1: ${savedCheckpoint !== null}`);
if (!savedCheckpoint) throw new Error("Expected a checkpoint to have been saved after the tool call completed");
console.log(`  checkpoint.agentName: "${savedCheckpoint.agentName}" (expected "worker")`);
console.log(`  toolExecutionCount so far: ${toolExecutionCount} (expected 1)`);
if (toolExecutionCount !== 1) throw new Error("Tool should have executed exactly once before the crash");

// Now "restart the process" — brand-new provider, brand-new client — and resume.
const recoveredProvider: Provider = {
  name: "openai",
  async generate(): Promise<GenerateResult> {
    throw new Error("not used");
  },
  stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    // If resumption is real, this call's `messages` should already include the
    // turn-1 assistant tool-call + tool-result — i.e. the model is being asked to
    // continue, not asked the original question from scratch.
    const hasToolResult = options.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "tool-result" && p.result === 42)
    );
    if (!hasToolResult) throw new Error("Resumed call did not receive the pre-crash tool result in its message history");
    yield* textStream("The number is 42.");
  },
};

const client2 = createClient({ provider: recoveredProvider });
const result = await resumeAgent(client2, agent, { checkpoint: { store: checkpointStore, runId: "run-1" } });

console.log(`  resumed run output: "${result.output}"`);
console.log(`  toolExecutionCount after resume: ${toolExecutionCount} (expected 1 — NOT re-executed)`);
if (toolExecutionCount !== 1) throw new Error("Resuming re-executed the tool call — this should never happen");
if (result.output !== "The number is 42.") throw new Error("Wrong final output after resume");
if (result.finalAgent !== "worker") throw new Error("Wrong finalAgent after resume");

const afterCompletion = await checkpointStore.load("run-1");
console.log(`  checkpoint auto-deleted after successful completion: ${afterCompletion === null}`);
if (afterCompletion !== null) throw new Error("Checkpoint should be deleted once the run completes successfully");

console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — resuming correctly locates a NON-root agent (post-handoff) within
// the handoff tree by name
// ===========================================================================
console.log("=== TEST 2: resume after a crash that happened post-handoff ===");

const specialist = defineAgent({
  name: "specialist",
  instructions: "Give a final answer.",
  model: "gpt-4o",
});
const router = defineAgent({
  name: "router",
  instructions: "Hand off to specialist immediately.",
  model: "gpt-4o",
  handoffs: [specialist],
});

let handoffCallCount = 0;
const handoffThenCrashProvider: Provider = {
  name: "openai",
  async generate(): Promise<GenerateResult> {
    throw new Error("not used");
  },
  stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    handoffCallCount++;
    if (handoffCallCount === 1) {
      // router hands off immediately
      yield {
        type: "tool-call",
        toolCall: { type: "tool-call", toolCallId: "h1", toolName: handoffToolName(specialist.name), args: {} },
      };
      yield { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
      return;
    }
    // specialist's turn: crash
    throw new Error("simulated crash after handoff");
  },
};

const checkpointStore2 = new InMemoryCheckpointStore();
const client3 = createClient({ provider: handoffThenCrashProvider });

try {
  await runAgent(client3, router, "help me", { checkpoint: { store: checkpointStore2, runId: "run-2" } });
  throw new Error("expected this run to crash");
} catch (err) {
  if (!(err instanceof AgentRunError)) throw err;
}

const checkpoint2 = await checkpointStore2.load("run-2");
console.log(`  checkpoint.agentName after handoff: "${checkpoint2?.agentName}" (expected "specialist")`);
if (checkpoint2?.agentName !== "specialist") throw new Error("Checkpoint should record the post-handoff agent, not the router");

const client4 = createClient({
  provider: {
    name: "openai",
    async generate(): Promise<GenerateResult> {
      throw new Error("not used");
    },
    stream: async function* (): AsyncIterable<StreamChunk> {
      yield* textStream("Specialist's final answer.");
    },
  },
});

// Resuming with `router` (the ROOT agent, not `specialist` directly) — proves
// findAgentByName() searched the handoff tree rather than requiring an exact match.
const resumed2 = await resumeAgent(client4, router, { checkpoint: { store: checkpointStore2, runId: "run-2" } });
console.log(`  resumed2.finalAgent: "${resumed2.finalAgent}" (expected "specialist")`);
console.log(`  resumed2.output: "${resumed2.output}"`);
if (resumed2.finalAgent !== "specialist") throw new Error("Wrong finalAgent for post-handoff resume");
if (resumed2.output !== "Specialist's final answer.") throw new Error("Wrong output for post-handoff resume");

console.log("✅ TEST 2 passed\n");

// ===========================================================================
// TEST 3 — resuming a runId with no checkpoint fails clearly, not silently
// ===========================================================================
console.log("=== TEST 3: resuming a nonexistent checkpoint throws CheckpointNotFoundError ===");

let threwNotFound = false;
try {
  await resumeAgent(client2, agent, { checkpoint: { store: new InMemoryCheckpointStore(), runId: "never-existed" } });
} catch (err) {
  threwNotFound = err instanceof CheckpointNotFoundError;
}
console.log(`  threw CheckpointNotFoundError: ${threwNotFound}`);
if (!threwNotFound) throw new Error("Expected CheckpointNotFoundError for a runId with no saved checkpoint");

console.log("✅ TEST 3 passed\n");

// ===========================================================================
// TEST 4 — FileCheckpointStore against the real filesystem
// ===========================================================================
console.log("=== TEST 4: FileCheckpointStore persists to a real file ===");

const { rmSync } = await import("node:fs");
const dir = "./__checkpoint_test_dir";
rmSync(dir, { recursive: true, force: true });

const fileStore = new FileCheckpointStore(dir);
await fileStore.save({
  runId: "file-run-1",
  agentName: "worker",
  messages: [{ role: "user", content: "hi" }],
  newMessagesStart: 0,
  turnsForCurrentAgent: 1,
  totalTurns: 1,
  handoffCount: 0,
  visitedAgents: ["worker"],
  trace: { runId: "file-run-1", startedAt: Date.now(), agentPath: ["worker"], events: [], totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
  savedAt: Date.now(),
});

// Open a brand-new store instance pointed at the same directory, to prove it's really durable.
const fileStore2 = new FileCheckpointStore(dir);
const loaded = await fileStore2.load("file-run-1");
console.log(`  reloaded from a new store instance: ${loaded !== null}`);
if (!loaded) throw new Error("FileCheckpointStore did not persist across instances");
console.log(`  loaded.agentName: "${loaded.agentName}" (expected "worker")`);
if (loaded.agentName !== "worker") throw new Error("Loaded checkpoint data is wrong");

await fileStore2.delete("file-run-1");
const afterDelete = await fileStore2.load("file-run-1");
console.log(`  after delete(): ${afterDelete === null}`);
if (afterDelete !== null) throw new Error("delete() did not remove the checkpoint file");

rmSync(dir, { recursive: true, force: true });
console.log("✅ TEST 4 passed\n");

console.log("🎉 All checkpoint/resume tests passed");
