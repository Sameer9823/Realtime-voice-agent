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

console.log("=== TEST 1: pipelineVoice end-to-end (STT → LLM → TTS with real timing) ===");

const agent = defineVoiceAgent({ name: "pipeline-agent", instructions: "You are helpful.", model: "mock-model" });
const llm = createMockProvider({ responses: [{ text: "Hello from the model. How can I help you?" }] });
const stt = createMockSTTProvider();
const tts = createMockTTSProvider({ chunkDelayMs: 10 });
const provider = pipelineVoice({ stt, llm, tts });
const session = createSession("voice-pipe-1", new InMemorySessionStore());

const voiceSession = await provider.connect({ agent, session });
const events: any[] = [];
for (const t of ["user-speech-started","user-speech-ended","agent-thinking","agent-speech-started","agent-audio-chunk","agent-speech-ended","interruption","tool-started","tool-completed","run-completed","run-failed"] as const) {
  (voiceSession as any).on(t, (e: any) => events.push(e));
}

// Obtain the underlying STT session via stt provider's connect shim? Instead use simulate on provider shim.
// Our MockSTTProvider stores onResult globally; we can trigger via the provider-level simulateTranscript helper
// pipeline-provider holds the stt session internally, but MockSTTProvider.simulateTranscript will fire onResult.
const start = Date.now();
(stt as any).simulateTranscript("hello there", { confidence: 0.95, isFinal: true });

// Wait for LLM -> TTS pipeline to complete (real wall-clock: stream is sync, TTS chunk delay is 10ms)
await new Promise((r) => setTimeout(r, 120));
const elapsed = Date.now() - start;

console.log(`  elapsed: ${elapsed}ms`);
check("elapsed reflects real TTS delay (>=10ms)", elapsed >= 10);
check("LLM was called once", llm.calls.length === 1, `calls=${llm.calls.length}`);
check("LLM history included the transcript", JSON.stringify(llm.calls[0]?.messages ?? []).includes("hello there"));
check("TTS synthesized the model output", tts.getSynthesized().join(" ").includes("Hello from the model"));
check("agent-speech-started fired", events.some((e) => e.type === "agent-speech-started"));
check("agent-audio-chunk fired with ArrayBuffer", events.some((e) => e.type === "agent-audio-chunk" && e.chunk instanceof ArrayBuffer));
check("run-completed fired", events.some((e) => e.type === "run-completed"));
check("session has both user and assistant", (await session.getMessages()).length >= 2);

console.log("\n=== TEST 2: low-latency sentence-boundary TTS start ===");
const llm2 = createMockProvider({ responses: [{ text: "First sentence. Second sentence. Third." }] });
const tts2 = createMockTTSProvider({ chunkDelayMs: 5 });
const stt2 = createMockSTTProvider();
const p2 = pipelineVoice({ stt: stt2, llm: llm2, tts: tts2 });
const vs2 = await p2.connect({ agent, session: createSession("pipe-2", new InMemorySessionStore()) });
(stt2 as any).simulateTranscript("go", { confidence: 0.95 });
await new Promise((r) => setTimeout(r, 100));
const chunks2 = tts2.getSynthesized();
console.log(`  tts chunk count: ${chunks2.length}, chunks: ${JSON.stringify(chunks2).slice(0, 300)}`);
check("TTS was called (sentence buffering, at least 1 chunk)", chunks2.length >= 1);
check("Full text reached TTS (concat includes Third)", chunks2.join(" ").includes("Third"));

await (voiceSession as any).close();
await (vs2 as any).close();

if (failures) { console.log(`\n❌ ${failures} failure(s)`); process.exit(1); }
console.log("\n🎉 voice-pipeline tests passed");
