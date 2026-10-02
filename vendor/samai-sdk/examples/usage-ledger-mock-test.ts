import { createUsageLedger } from "../src/index.js";
import type { GenerateOptions, GenerateResult, Provider, StreamChunk } from "../src/types.js";

// ===========================================================================
// TEST 1 — wrapProvider() attributes usage to the right key from real calls
// (generate), across multiple keys and multiple models
// ===========================================================================
console.log("=== TEST 1: per-session/user cost attribution via wrapProvider() (generate) ===");

const baseProvider: Provider = {
  name: "test",
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const usage =
      options.model === "gpt-4o-mini"
        ? { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 } // $0.15 + $0.60 = $0.75
        : { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }; // claude-sonnet-4-6: $3 + $15 = $18
    return { model: options.model, text: "ok", toolCalls: [], finishReason: "stop", usage, messages: [], raw: null };
  },
  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error("not used in TEST 1");
  },
};

const recorded: string[] = [];
const ledger = createUsageLedger({ onRecord: (info) => recorded.push(info.key) });
const provider = ledger.wrapProvider(baseProvider, (options) => options.metadata?.sessionId as string | undefined);

await provider.generate({ model: "gpt-4o-mini", messages: [], metadata: { sessionId: "session-a" } });
await provider.generate({ model: "claude-sonnet-4-6", messages: [], metadata: { sessionId: "session-a" } });
await provider.generate({ model: "gpt-4o-mini", messages: [], metadata: { sessionId: "session-b" } });
await provider.generate({ model: "gpt-4o-mini", messages: [] }); // no metadata at all

const statsA = ledger.getStats("session-a");
console.log(`  session-a callCount: ${statsA.callCount} (expected 2)`);
if (statsA.callCount !== 2) throw new Error("session-a should have 2 recorded calls");

console.log(`  session-a totalCostUsd: $${statsA.totalCostUsd.toFixed(2)} (expected $18.75 = $0.75 + $18)`);
if (Math.abs(statsA.totalCostUsd - 18.75) > 0.001) throw new Error(`Wrong cost for session-a: ${statsA.totalCostUsd}`);

console.log(`  session-a byModel breakdown: ${JSON.stringify(Object.keys(statsA.byModel).sort())} (expected [claude-sonnet-4-6, gpt-4o-mini])`);
if (JSON.stringify(Object.keys(statsA.byModel).sort()) !== JSON.stringify(["claude-sonnet-4-6", "gpt-4o-mini"])) {
  throw new Error("session-a should have a byModel entry for each model it used");
}

const statsB = ledger.getStats("session-b");
console.log(`  session-b totalCostUsd: $${statsB.totalCostUsd.toFixed(2)} (expected $0.75, isolated from session-a)`);
if (Math.abs(statsB.totalCostUsd - 0.75) > 0.001) throw new Error("session-b should be isolated from session-a");

const unattributed = ledger.getStats("_unattributed");
console.log(`  calls with no metadata land under "_unattributed": ${unattributed.callCount === 1}`);
if (unattributed.callCount !== 1) throw new Error("A call with no sessionId should be tracked, not silently dropped");

console.log(`  a never-used key returns zeroed stats (not undefined): ${ledger.getStats("nonexistent").callCount === 0}`);

console.log(`  onRecord fired once per call: ${recorded.length === 4}`);
if (recorded.length !== 4) throw new Error("onRecord should fire exactly once per generate() call");

console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — wrapProvider() also records usage from the streaming path (finish chunk)
// ===========================================================================
console.log("=== TEST 2: streaming calls are recorded from the finish chunk ===");

const streamProvider: Provider = {
  name: "test",
  async generate(): Promise<GenerateResult> {
    throw new Error("not used in TEST 2");
  },
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: "text-delta", textDelta: "hello" };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
  },
};

const streamLedger = createUsageLedger();
const wrappedStream = streamLedger.wrapProvider(streamProvider, (o) => o.metadata?.userId as string | undefined);

const chunks: StreamChunk[] = [];
for await (const chunk of wrappedStream.stream({ model: "gpt-4o", messages: [], metadata: { userId: "user-1" } })) {
  chunks.push(chunk);
}

console.log(`  chunks pass through unmodified: ${chunks.length === 2}`);
if (chunks.length !== 2) throw new Error("wrapProvider() should not alter the stream's chunks");

const userStats = streamLedger.getStats("user-1");
console.log(`  user-1 totalTokens after stream: ${userStats.totalTokens} (expected 150)`);
if (userStats.totalTokens !== 150) throw new Error("Streaming usage should be recorded from the finish chunk");

console.log("✅ TEST 2 passed\n");

// ===========================================================================
// TEST 3 — getAllStats(), reset(), and toJSON() snapshot shape
// ===========================================================================
console.log("=== TEST 3: getAllStats(), reset(), and toJSON() ===");

const all = ledger.getAllStats();
console.log(`  getAllStats() has all 3 keys: ${Object.keys(all).sort().join(",")} (expected _unattributed,session-a,session-b)`);
if (Object.keys(all).sort().join(",") !== "_unattributed,session-a,session-b") {
  throw new Error("getAllStats() should return every key that has recorded usage");
}

ledger.reset("session-b");
console.log(`  reset("session-b") clears only that key: ${ledger.getStats("session-b").callCount === 0 && ledger.getStats("session-a").callCount === 2}`);
if (ledger.getStats("session-b").callCount !== 0) throw new Error("reset(key) should clear that key");
if (ledger.getStats("session-a").callCount !== 2) throw new Error("reset(key) should NOT touch other keys");

const snapshot = ledger.toJSON();
console.log(`  toJSON() snapshot has generatedAt + entries: ${typeof snapshot.generatedAt === "string" && Array.isArray(snapshot.entries)}`);
if (typeof snapshot.generatedAt !== "string" || !Array.isArray(snapshot.entries)) throw new Error("toJSON() shape is wrong");

const sessionAEntry = snapshot.entries.find((e) => e.key === "session-a");
console.log(`  snapshot entry for session-a carries its stats: ${sessionAEntry?.callCount === 2}`);
if (sessionAEntry?.callCount !== 2) throw new Error("snapshot entries should carry each key's real stats");

ledger.reset();
console.log(`  reset() with no key clears everything: ${Object.keys(ledger.getAllStats()).length === 0}`);
if (Object.keys(ledger.getAllStats()).length !== 0) throw new Error("reset() with no args should clear all keys");

console.log("✅ TEST 3 passed\n");

console.log("🎉 All usage-ledger tests passed");
