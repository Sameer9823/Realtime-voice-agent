import { openaiRealtime } from "../src/voice/realtime/openai-realtime.js";
import { defineVoiceAgent } from "../src/voice/voice-agent.js";
import { createSession, InMemorySessionStore } from "../src/session.js";

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  \u2705 ${label}`);
  else { console.log(`  \u274c ${label}`); failures++; }
}

console.log("=== TEST: openaiRealtime mock + pipeline-like surface ===");
const agent = defineVoiceAgent({ name: "rt-agent", instructions: "helpful", model: "gpt-4o-realtime" });
const provider = openaiRealtime({ apiKey: "mock" });
check("provider name is openai-realtime", provider.name === "openai-realtime");

const session = createSession("rt-1", new InMemorySessionStore());
const vs: any = await provider.connect({ agent, session });
check("connect returns a VoiceSession with sendAudio/interrupt/close/on", typeof vs.sendAudio === "function" && typeof vs.interrupt === "function" && typeof vs.close === "function" && typeof vs.on === "function");

const events: any[] = [];
for (const t of ["agent-audio-chunk","agent-speech-started","interruption"] as const) vs.on(t, (e:any) => events.push(e));

vs.sendAudio(new ArrayBuffer(8));
check("sendAudio does not throw in mock mode", true);

vs.interrupt();
await new Promise(r => setTimeout(r, 10));
check("interrupt emits interruption", events.some(e => e.type === "interruption"));
check("realtime session has _trace", !!vs._trace);

await vs.close();
check("close does not throw", true);

const p2 = openaiRealtime({});
const vs2: any = await p2.connect({ agent, session: createSession("rt-2", new InMemorySessionStore()) });
check("no-apiKey also produces mock session", typeof vs2.sendAudio === "function");
await vs2.close();

if (failures) { console.log(`\n\u274c ${failures} failure(s)`); process.exit(1); }
console.log("\n\uD83C\uDF89 voice-realtime tests passed");
