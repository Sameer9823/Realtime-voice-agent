import { createSession, InMemorySessionStore } from "../src/session.js";
import { pipelineVoice } from "../src/voice/pipeline/pipeline-provider.js";
import { createMockSTTProvider, createMockTTSProvider } from "../src/voice/testing.js";
import { createMockProvider } from "../src/testing.js";
import { defineVoiceAgent } from "../src/voice/voice-agent.js";

let failures = 0;
function check(label: string, cond: boolean, detail="") {
  if (cond) console.log(`  \u2705 ${label}${detail ? " \u2014 "+detail : ""}`);
  else { console.log(`  \u274c ${label}${detail ? " \u2014 "+detail : ""}`); failures++; }
}

console.log("=== TEST: voice+text share same SessionStore ===");
const store = new InMemorySessionStore();
const session = createSession("shared-1", store);
const agent = defineVoiceAgent({ name: "cont-agent", instructions: "You are helpful.", model: "mock" });

const llm1 = createMockProvider({ responses: [{ text: "Got it, I remember you like hiking." }] });
const stt1 = createMockSTTProvider();
const tts1 = createMockTTSProvider({ chunkDelayMs: 5 });
const vs1: any = await pipelineVoice({ stt: stt1, llm: llm1, tts: tts1 }).connect({ agent, session });
(stt1 as any).simulateTranscript("I like hiking", { confidence: 0.95 });
await new Promise(r => setTimeout(r, 100));
let msgs = await session.getMessages();
console.log(`  after voice turn 1: ${msgs.length} msgs`);
check("voice turn persisted user + assistant", msgs.length >= 2);
check("user message is hiking", msgs.some(m => typeof m.content === "string" && (m.content as string).includes("hiking")));

const llm2 = createMockProvider({ responses: [{ text: "Yes, you mentioned hiking before." }] });
const stt2 = createMockSTTProvider();
const tts2 = createMockTTSProvider({ chunkDelayMs: 5 });
const vs2: any = await pipelineVoice({ stt: stt2, llm: llm2, tts: tts2 }).connect({ agent, session });
vs2.on("run-completed", (e: any) => {});
(stt2 as any).simulateTranscript("what do I like?", { confidence: 0.95 });
await new Promise(r => setTimeout(r, 100));
check("second turn LLM called with history including hiking", JSON.stringify(llm2.calls[0]?.messages ?? []).includes("hiking"));
msgs = await session.getMessages();
console.log(`  after voice turn 2: ${msgs.length} msgs`);
check("session grew to >=4 after second turn", msgs.length >= 4);

await session.appendMessages([{ role: "user", content: "also I love cooking" }]);
const llm3 = createMockProvider({ responses: [{ text: "Noted cooking." }] });
const stt3 = createMockSTTProvider();
const tts3 = createMockTTSProvider({ chunkDelayMs: 5 });
const vs3: any = await pipelineVoice({ stt: stt3, llm: llm3, tts: tts3 }).connect({ agent, session });
(stt3 as any).simulateTranscript("what else do I like?", { confidence: 0.95 });
await new Promise(r => setTimeout(r, 100));
check("voice turn sees text-appended history (cooking)", JSON.stringify(llm3.calls[0]?.messages ?? []).includes("cooking"));

await vs1.close(); await vs2.close(); await vs3.close();

console.log("\n=== TEST: session isolation (different sessionId) ===");
const sA = createSession("shared-A", store);
const sB = createSession("shared-B", store);
await sA.appendMessages([{ role: "user", content: "secret A" }]);
const bMsgs = await sB.getMessages();
check("different sessionId isolated", bMsgs.length === 0);

if (failures) { console.log(`\n\u274c ${failures} failure(s)`); process.exit(1); }
console.log("\n\uD83C\uDF89 voice-session-continuity tests passed");
