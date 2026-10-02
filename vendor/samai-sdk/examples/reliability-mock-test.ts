import { z } from "zod";
import {
  createClient,
  defineAgent,
  runAgent,
  runAgentStream,
  withTimeout,
  TimeoutError,
  createDangerousToolGuardrail,
} from "../src/index.js";
import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../src/types.js";

function textDeltaChunks(text: string): StreamChunk[] {
  return text.match(/.{1,8}/g)!.map((t) => ({ type: "text-delta", textDelta: t }));
}

// ===========================================================================
// TEST 1 — withTimeout() actually aborts a hung provider call
// ===========================================================================
console.log("=== TEST 1: withTimeout() aborts a call that never resolves ===");

const hangingProvider: Provider = {
  name: "openai",
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    // Never resolves on its own — only an AbortSignal can end this.
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  },
  async *stream(): AsyncIterable<StreamChunk> {
    await new Promise(() => {}); // never yields
  },
};

const timeLimited = withTimeout(hangingProvider, { timeoutMs: 100 });

const start = Date.now();
let caughtTimeout = false;
try {
  await timeLimited.generate({ model: "test", messages: [{ role: "user", content: "hi" }] });
} catch (err) {
  if (err instanceof TimeoutError) {
    caughtTimeout = true;
    console.log(`  Caught expected TimeoutError after ${Date.now() - start}ms:`, err.message);
  } else {
    throw err;
  }
}
if (!caughtTimeout) throw new Error("Expected withTimeout() to throw a TimeoutError");
console.log("✅ TEST 1 passed\n");

// ===========================================================================
// Shared mock provider + client for the agent-runtime tests below
// ===========================================================================

const mockProvider: Provider = {
  name: "openai",
  async generate() {
    throw new Error("not used — agent runtime always calls stream()");
  },
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const system = options.system ?? "";

    if (system.startsWith("OPS_AGENT")) {
      const alreadyRanTools = options.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "tool-result")
      );
      if (!alreadyRanTools) {
        // Fire all three tool calls in one turn so a single run exercises the
        // dangerous-call guardrail, the approval gate, and a normal tool call.
        yield {
          type: "tool-call",
          toolCall: { type: "tool-call", toolCallId: "c1", toolName: "wipe_database", args: { table: "users" } },
        };
        yield {
          type: "tool-call",
          toolCall: { type: "tool-call", toolCallId: "c2", toolName: "send_email", args: { to: "team@example.com", body: "Deploy done" } },
        };
        yield { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
        return;
      }
      yield* textDeltaChunks("Done — see tool results above.");
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
      return;
    }

    throw new Error(`mock provider: no script for system prompt: ${system.slice(0, 40)}`);
  },
};

const client = createClient({ provider: mockProvider });

const wipeDatabase = {
  name: "wipe_database",
  description: "Deletes all rows from a table",
  parameters: z.object({ table: z.string() }),
  execute: async ({ table }: { table: string }) => `wiped ${table}`,
};

const sendEmail = {
  name: "send_email",
  description: "Sends an email",
  parameters: z.object({ to: z.string(), body: z.string() }),
  execute: async ({ to }: { to: string }) => `email sent to ${to}`,
  requiresApproval: true as const,
};

const opsAgent = defineAgent({
  name: "ops_agent",
  instructions: "OPS_AGENT: perform requested ops tasks using the available tools.",
  model: "fake-model",
  tools: [wipeDatabase, sendEmail],
  guardrails: {
    tool: [createDangerousToolGuardrail({ blockedTools: ["wipe_database"] })],
  },
});

// ===========================================================================
// TEST 2 — tool guardrail blocks a dangerous call before it ever executes
// ===========================================================================
console.log("=== TEST 2: tool guardrail blocks wipe_database before execution ===");

let wipeGuardrailFired = false;
{
  const gen = runAgentStream(client, opsAgent, "Wipe the users table and email the team.");
  let step = await gen.next();
  while (!step.done) {
    if (step.value.type === "guardrail-triggered" && step.value.stage === "tool") {
      wipeGuardrailFired = true;
      console.log("  guardrail-triggered (tool):", step.value.reason);
    }
    if (step.value.type === "tool-completed" && step.value.toolName === "wipe_database") {
      console.log("  wipe_database result:", step.value.result, "(should be an error, not an actual wipe)");
      if (!step.value.isError) throw new Error("wipe_database should have been blocked, not executed");
    }
    step = await gen.next();
  }
}
if (!wipeGuardrailFired) throw new Error("Expected the tool guardrail to fire for wipe_database");
console.log("✅ TEST 2 passed\n");

// ===========================================================================
// TEST 3 — approval gate: rejecting a proposed action stops it from running
// ===========================================================================
console.log("=== TEST 3: approval gate rejects send_email ===");

let emailActuallySent = false;
const sendEmailTracking = { ...sendEmail, execute: async (args: { to: string; body: string }) => { emailActuallySent = true; return sendEmail.execute(args); } };
const opsAgentRejectCase = defineAgent({ ...opsAgent, tools: [wipeDatabase, sendEmailTracking] });

const resultRejected = await runAgent(client, opsAgentRejectCase, "Wipe the users table and email the team.", {
  onApprovalRequest: async ({ toolName }) => {
    console.log(`  approval requested for "${toolName}" -> rejecting`);
    return false;
  },
});

if (emailActuallySent) throw new Error("Email should NOT have been sent — approval was rejected");
console.log("  Final answer:", resultRejected.text);
console.log("✅ TEST 3 passed (rejected action never executed)\n");

// ===========================================================================
// TEST 4 — approval gate: approving lets the action run
// ===========================================================================
console.log("=== TEST 4: approval gate approves send_email ===");

emailActuallySent = false;
const resultApproved = await runAgent(client, opsAgentRejectCase, "Wipe the users table and email the team.", {
  onApprovalRequest: async ({ toolName }) => {
    console.log(`  approval requested for "${toolName}" -> approving`);
    return true;
  },
});

if (!emailActuallySent) throw new Error("Email SHOULD have been sent — approval was granted");
console.log("  Final answer:", resultApproved.text);
console.log("✅ TEST 4 passed (approved action executed)\n");

// ===========================================================================
// TEST 5 — no approval handler configured: fails closed by default
// ===========================================================================
console.log("=== TEST 5: no onApprovalRequest handler -> fails closed ===");

emailActuallySent = false;
const resultNoHandler = await runAgent(client, opsAgentRejectCase, "Wipe the users table and email the team.");

if (emailActuallySent) throw new Error("Email should NOT have been sent with no approval handler configured");
console.log("  Final answer:", resultNoHandler.text);
console.log("✅ TEST 5 passed (fail-closed default protected an unattended run)\n");

console.log("🎉 All reliability tests passed");
