import * as v from "valibot";
import { z } from "zod";
import {
  createClient,
  createSchemaGuardrail,
  defineAgent,
  generateObject,
  runAgent,
  streamObject,
} from "../src/index.js";
import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../src/types.js";

function textProvider(text: string | ((options: GenerateOptions) => string)): Provider {
  let callIndex = 0;
  return {
    name: "test",
    async generate(options: GenerateOptions): Promise<GenerateResult> {
      const t = typeof text === "function" ? text(options) : text;
      callIndex++;
      return { model: options.model, text: t, toolCalls: [], finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, messages: [], raw: { callIndex } };
    },
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const t = typeof text === "function" ? text(options) : text;
      yield { type: "text-delta", textDelta: t };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
  };
}

// ===========================================================================
// TEST 1 — generateObject() validates against a valibot schema, including a
// genuine repair pass (invalid -> valid), proving the Standard Schema path
// runs the real validate()/issues machinery, not a stub
// ===========================================================================
console.log("=== TEST 1: generateObject() with a valibot schema — validate + repair ===");

const ReviewSchema = v.object({
  summary: v.string(),
  score: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
});

let genCalls = 0;
const repairProvider: Provider = {
  name: "test",
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    genCalls++;
    // First attempt: score is out of range (11 > maxValue 10) -> valibot should reject it.
    // Second attempt (after repair prompt): valid.
    const text = genCalls === 1 ? JSON.stringify({ summary: "Great trip", score: 11 }) : JSON.stringify({ summary: "Great trip", score: 9 });
    return { model: options.model, text, toolCalls: [], finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, messages: [], raw: null };
  },
  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error("not used");
  },
};

const client1 = createClient({ provider: repairProvider });
const objResult = await generateObject(client1, {
  model: "test-model",
  schema: ReviewSchema,
  messages: [{ role: "user", content: "Summarize this trip." }],
});

console.log(`  attempts: ${objResult.attempts} (expected 2 — first attempt out-of-range, valibot rejected it)`);
if (objResult.attempts !== 2) throw new Error(`Expected valibot's minValue/maxValue validation to reject the first attempt, got ${objResult.attempts} attempts`);

console.log(`  object: ${JSON.stringify(objResult.object)} (expected score: 9, within range)`);
if (objResult.object.score !== 9) throw new Error("Final object should be the valid, in-range one");

console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — streamObject() with a valibot schema: partial streaming still
// works (schema-agnostic), and final validation runs through valibot
// ===========================================================================
console.log("=== TEST 2: streamObject() with a valibot schema ===");

const CardSchema = v.object({ title: v.string(), count: v.number() });
const streamClient = createClient({ provider: textProvider(JSON.stringify({ title: "Widgets", count: 3 })) });

const streamResult = streamObject(streamClient, {
  model: "test-model",
  schema: CardSchema,
  messages: [{ role: "user", content: "Give me a card." }],
});

const partials: unknown[] = [];
for await (const partial of streamResult.partialObjectStream) partials.push(partial);
const finalObject = await streamResult.object;

console.log(`  received ${partials.length} partial emit(s) before the final object`);
if (partials.length === 0) throw new Error("streamObject() should emit at least one partial before finishing");

console.log(`  final object validated by valibot: ${JSON.stringify(finalObject)}`);
if (finalObject.title !== "Widgets" || finalObject.count !== 3) throw new Error("Final streamed object should match the valibot schema");

console.log("✅ TEST 2 passed\n");

// ===========================================================================
// TEST 3 — createSchemaGuardrail() with a valibot schema, strict mode blocking
// on a genuine valibot validation failure (wrong type, not just malformed JSON)
// ===========================================================================
console.log("=== TEST 3: createSchemaGuardrail() with a valibot schema ===");

const guardrail = createSchemaGuardrail(v.object({ ok: v.boolean() }));

const goodOutcome = await guardrail({
  result: { model: "test", text: JSON.stringify({ ok: true }), toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, messages: [], raw: null },
});
console.log(`  valid output allowed through, object attached: ${goodOutcome.allowed && (goodOutcome.modifiedResult?.object as any)?.ok === true}`);
if (!goodOutcome.allowed) throw new Error("Valid valibot output should be allowed");

// wrong type (string instead of boolean) — a real valibot type-validation failure, not just bad JSON
const badOutcome = await guardrail({
  result: { model: "test", text: JSON.stringify({ ok: "yes" }), toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, messages: [], raw: null },
});
console.log(`  type-mismatched output blocked by valibot's own validation: ${!badOutcome.allowed}`);
if (badOutcome.allowed) throw new Error("valibot should have rejected `ok: \"yes\"` against a boolean schema");

console.log("✅ TEST 3 passed\n");

// ===========================================================================
// TEST 4 — Agent.outputSchema accepts a valibot schema, driving a real
// runAgent() structured-output + repair loop end-to-end
// ===========================================================================
console.log("=== TEST 4: runAgent() with a valibot Agent.outputSchema ===");

const PlanSchema = v.object({ steps: v.array(v.string()) });

let agentCalls = 0;
const agentProvider: Provider = {
  name: "test",
  async generate(): Promise<GenerateResult> {
    throw new Error("not used — runAgent drives through stream()");
  },
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    agentCalls++;
    // First reply is plain prose (fails valibot validation entirely) -> triggers a repair turn.
    const text = agentCalls === 1 ? "Sure, here is a plan for you." : JSON.stringify({ steps: ["Plan trip", "Book flights"] });
    yield { type: "text-delta", textDelta: text };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  },
};

const agentClient = createClient({ provider: agentProvider });
const planningAgent = defineAgent({
  name: "planner",
  instructions: "Return a JSON plan.",
  model: "test-model",
  outputSchema: PlanSchema,
});

const agentRunResult = await runAgent(agentClient, planningAgent, "Plan my trip.");
console.log(`  agentCalls: ${agentCalls} (expected 2 — prose reply failed valibot validation, triggered a repair turn)`);
if (agentCalls !== 2) throw new Error("Expected the run loop's outputSchema check to reject the first, non-JSON reply and re-prompt");

console.log(`  final structured output: ${JSON.stringify(agentRunResult.output)}`);
if (JSON.stringify(agentRunResult.output) !== JSON.stringify({ steps: ["Plan trip", "Book flights"] })) {
  throw new Error("Agent's final output should be the valibot-validated structured object");
}

console.log("✅ TEST 4 passed\n");

// ===========================================================================
// TEST 5 — zod behavior is completely unchanged (regression guard: the schema
// adapter must not alter existing zod validation/error messages)
// ===========================================================================
console.log("=== TEST 5: zod schemas still behave exactly as before (regression guard) ===");

const zodClient = createClient({ provider: textProvider(JSON.stringify({ ok: true })) });
const zodResult = await generateObject(zodClient, {
  model: "test-model",
  schema: z.object({ ok: z.boolean() }),
  messages: [{ role: "user", content: "hi" }],
});
console.log(`  zod path still works: ${JSON.stringify(zodResult.object)}`);
if (zodResult.object.ok !== true) throw new Error("zod schemas should still validate exactly as before");

console.log("✅ TEST 5 passed\n");

console.log("🎉 All valibot (Standard Schema) tests passed");
