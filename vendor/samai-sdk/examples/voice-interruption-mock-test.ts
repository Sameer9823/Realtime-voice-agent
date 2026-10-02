import { createMockProvider } from "../src/testing.js";
import { createSession, InMemorySessionStore } from "../src/session.js";
import { pipelineVoice } from "../src/voice/pipeline/pipeline-provider.js";
import { createMockSTTProvider, createMockTTSProvider } from "../src/voice/testing.js";
import { defineVoiceAgent } from "../src/voice/voice-agent.js";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✅ ${label}${detail ? " — " + detail : ""}`);
  else { console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`); failures++; }
}

console.log("=== TEST: barge-in interruption (confidence-gated) ===");
const agent = defineVoiceAgent({ name: "barge-agent", instructions: "Be brief.", model: "mock", voice: { interruption: "confidence-gated" } });

// LLM that streams slowly so we can interrupt mid-speech
const slowLLM = createMockProvider({ responses: [
  { text: "This is a very long answer that streams sentence by sentence. ", delayMs: 5 },
  { text: "Second chunk continues. ", delayMs: 5 },
]});

// Use the shaper to ensure long: but simpler — just use two calls
const manualLLM = {
  name: "manual-slow",
  async generate() { throw new Error("not used"); },
  async *stream(_opts: any) {
    yield { type: "text-delta", textDelta: "First sentence. " } as any;
    await new Promise((r) => setTimeout(r, 40));
    yield { type: "text-delta", textDelta: "Second sentence that should be cancelled. " } as any;
    await new Promise((r) => setTimeout(r, 40));
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 } } as any;
  }
};

const stt = createMockSTTProvider();
const tts = createMockTTSProvider({ chunkDelayMs: 120 }); // long TTS so speaking window stays open for barge-in
const provider = pipelineVoice({ stt, llm: manualLLM as any, tts });
const session = createSession("barge-1", new InMemorySessionStore());
const vs: any = await provider.connect({ agent, session });

const events: any[] = [];
for (const t of ["agent-speech-started","agent-speech-ended","interruption","run-completed"] as const) {
  vs.on(t, (e: any) => events.push(e));
}

console.log("  triggering first transcript to start LLM+TTS...");
(stt as any).simulateTranscript("tell me something", { confidence: 0.95 });
await new Promise((r) => setTimeout(r, 12));
console.log(`  after 12ms: events=${events.map((e)=>e.type).join(",")}, state speaking? ${events.some(e=>e.type==="agent-speech-started")}`);
check("agent started speaking", events.some((e) => e.type === "agent-speech-started"));

// Now barge in with HIGH confidence — should interrupt (before TTS done fires at ~120ms)
console.log("  high-confidence barge-in...");
(stt as any).simulateTranscript("STOP stop stop", { confidence: 0.92 });
await new Promise((r) => setTimeout(r, 40));
console.log(`  after barge-in: events=${events.map((e)=>e.type).join(",")}`);
check("high-confidence barge-in produced interruption", events.some((e) => e.type === "interruption"));
check("TTS was cancelled on barge-in", tts.wasCancelled() || tts.getCancelled());

// --- second scenario: low-confidence blip should NOT barge in ---
console.log("\n=== TEST: low-confidence blip is ignored ===");
const stt2 = createMockSTTProvider();
const tts2 = createMockTTSProvider({ chunkDelayMs: 30 });
const vs2: any = await (pipelineVoice({ stt: stt2, llm: manualLLM as any, tts: tts2 }).connect({ agent, session: createSession("barge-2", new InMemorySessionStore()) }));
const events2: any[] = [];
for (const t of ["agent-speech-started","interruption"] as const) vs2.on(t, (e: any) => events2.push(e));
(stt2 as any).simulateTranscript("hello", { confidence: 0.95 });
await new Promise((r) => setTimeout(r, 35));
check("speaking started (2)", events2.some((e) => e.type === "agent-speech-started"));
// send a low-confidence non-final blip (like a cough)
(stt2 as any).simulateTranscript("cough", { confidence: 0.15, isFinal: false });
await new Promise((r) => setTimeout(r, 40));
check("low-confidence blip did NOT interrupt", !events2.some((e) => e.type === "interruption"));

// --- disabled mode: nothing interrupts ---
console.log("\n=== TEST: disabled interruption never barge-ins ===");
const agentOff = defineVoiceAgent({ name: "no-barge", instructions: "x", model: "mock", voice: { interruption: "disabled" } });
const stt3 = createMockSTTProvider();
const tts3 = createMockTTSProvider({ chunkDelayMs: 30 });
const vs3: any = await pipelineVoice({ stt: stt3, llm: manualLLM as any, tts: tts3 }).connect({ agent: agentOff, session: createSession("barge-3", new InMemorySessionStore()) });
const events3: any[] = [];
for (const t of ["agent-speech-started","interruption"] as const) vs3.on(t, (e: any) => events3.push(e));
(stt3 as any).simulateTranscript("hello", { confidence: 0.95 });
await new Promise((r) => setTimeout(r, 35));
(stt3 as any).simulateTranscript("INTERRUPT ME", { confidence: 0.99 });
await new Promise((r) => setTimeout(r, 40));
check("disabled mode: high-confidence still does NOT interrupt", !events3.some((e) => e.type === "interruption"));

// explicit interrupt() always works regardless of mode
console.log("\n=== TEST: explicit interrupt() ===");
vs3.interrupt();
await new Promise((r) => setTimeout(r, 10));
check("explicit interrupt() fires interruption", events3.some((e) => e.type === "interruption"));

await vs.close(); await vs2.close(); await vs3.close();

if (failures) { console.log(`\n❌ ${failures} failure(s)`); process.exit(1); }
console.log("\n🎉 voice-interruption tests passed");
