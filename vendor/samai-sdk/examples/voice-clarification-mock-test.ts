import { ClarificationPolicy } from "../src/voice/behavior/clarification-policy.js";
import { pipelineVoice } from "../src/voice/pipeline/pipeline-provider.js";
import { createMockSTTProvider, createMockTTSProvider } from "../src/voice/testing.js";
import { createSession, InMemorySessionStore } from "../src/session.js";
import { defineVoiceAgent } from "../src/voice/voice-agent.js";

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  \u2705 ${label}`);
  else { console.log(`  \u274c ${label}`); failures++; }
}

console.log("=== TEST: ClarificationPolicy direct ===");
const policy = new ClarificationPolicy();
check("low confidence triggers clarification", policy.decide({ transcript: "hello", confidence: 0.3, intentAmbiguous: false }).shouldClarify === true);
check("low confidence question mentions heard text", (policy.decide({ transcript: "hello world", confidence: 0.2, intentAmbiguous: false }).question ?? "").includes("hello world"));
check("empty transcript low confidence asks to repeat", (policy.decide({ transcript: "  ", confidence: 0.1, intentAmbiguous: false }).question ?? "").includes("say it again"));
check("high confidence not ambiguous -> no clarification", policy.decide({ transcript: "book a flight to Paris", confidence: 0.9, intentAmbiguous: false }).shouldClarify === false);
check("high confidence but ambiguous + missing fields -> clarification", policy.decide({ transcript: "maybe Paris or London?", confidence: 0.9, intentAmbiguous: true, missingFields: ["destination"] }).shouldClarify === true);
check("ambiguous question mentions missing field", (policy.decide({ transcript: "maybe?", confidence: 0.9, intentAmbiguous: true, missingFields: ["date"] }).question ?? "").includes("date"));

console.log("\n=== TEST: pipeline low-confidence triggers clarification without LLM ===");
const agent = defineVoiceAgent({ name: "clar-agent", instructions: "helpful", model: "mock" });
let llmCalls = 0;
const llm: any = {
  name: "counting-llm",
  async generate() { llmCalls++; throw new Error("not used"); },
  async *stream() { llmCalls++; yield { type: "text-delta", textDelta: "should not happen" } as any; yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any; }
};
const stt = createMockSTTProvider();
const tts = createMockTTSProvider({ chunkDelayMs: 5 });
const vs: any = await pipelineVoice({ stt, llm, tts }).connect({ agent, session: createSession("clar-1", new InMemorySessionStore()) });
const events: any[] = [];
vs.on("clarification-requested", (e: any) => events.push(e));
vs.on("agent-speech-started", (e: any) => events.push(e));
(stt as any).simulateTranscript("mumble mumble", { confidence: 0.2 });
await new Promise(r => setTimeout(r, 80));
check("clarification-requested fired on low confidence", events.some(e => e.type === "clarification-requested"));
check("LLM NOT called when clarified", llmCalls === 0);
check("TTS synthesized the clarification question", tts.getSynthesized().join(" ").includes("Sorry"));

console.log("\n=== TEST: high confidence does call LLM ===");
const stt2 = createMockSTTProvider();
const tts2 = createMockTTSProvider({ chunkDelayMs: 5 });
let llmCalls2 = 0;
const llm2: any = {
  name: "counting-llm2",
  async generate() { llmCalls2++; throw new Error("not used"); },
  async *stream() { llmCalls2++; yield { type: "text-delta", textDelta: "answer. " } as any; yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any; }
};
const vs2: any = await pipelineVoice({ stt: stt2, llm: llm2, tts: tts2 }).connect({ agent, session: createSession("clar-2", new InMemorySessionStore()) });
(stt2 as any).simulateTranscript("what is the weather", { confidence: 0.95 });
await new Promise(r => setTimeout(r, 80));
check("high confidence DID call LLM", llmCalls2 === 1);

await vs.close(); await vs2.close();

if (failures) { console.log(`\n\u274c ${failures} failure(s)`); process.exit(1); }
console.log("\n\uD83C\uDF89 voice-clarification tests passed");
