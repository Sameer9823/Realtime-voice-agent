import { ConversationEngine } from "../src/voice/conversation-engine.js";
import { defineVoiceAgent } from "../src/voice/voice-agent.js";

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  \u2705 ${label}`);
  else { console.log(`  \u274c ${label}`); failures++; }
}

console.log("=== TEST: turn-taking state machine ===");
const agent = defineVoiceAgent({ name: "turn-agent", instructions: "helpful", model: "mock" });
const e2 = new ConversationEngine({ agent, onEvent: (e) => events.push(e.type) });
const events: string[] = [];

check("initial state is idle", e2.getState() === "idle");
e2.handleUserSpeechStarted();
check("after speech started -> listening", e2.getState() === "listening");
const clar = e2.handleUserSpeechEnded("hello there", 0.9);
check("handleUserSpeechEnded high confidence -> null (no clarification)", clar === null);
check("emitted user-speech-ended", events.includes("user-speech-ended"));
e2.handleAgentThinking();
check("thinking state", e2.getState() === "thinking");
check("emitted agent-thinking", events.includes("agent-thinking"));
e2.handleAgentSpeechStarted();
check("speaking state", e2.getState() === "speaking");
const did = e2.handleBargeIn({ confidence: 0.9, durationMs: 400, transcript: "wait" });
check("barge-in while speaking succeeds", did === true);
check("state is interrupted after barge-in", e2.getState() === "interrupted");
check("emitted interruption", events.includes("interruption"));
const e3 = new ConversationEngine({ agent: defineVoiceAgent({ name: "x", instructions: "x", model: "m" }) });
check("barge-in when idle returns false", e3.handleBargeIn({ confidence: 0.99, durationMs: 500 }) === false);
const e4 = new ConversationEngine({ agent });
e4.handleAgentSpeechStarted();
e4.handleExplicitInterrupt();
check("explicit interrupt -> interrupted", e4.getState() === "interrupted");
e4.handleRunCompleted({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
check("run completed -> idle", e4.getState() === "idle");
const e5 = new ConversationEngine({ agent });
e5.handleUserSpeechEnded("I want dogs", 0.9);
const corr = e5.handleUserSpeechEnded("no actually I want cats", 0.9);
check("correction returns null when high confidence", corr === null);
check("partial context updated after correction", e5.getPartialContext().includes("cats"));

if (failures) { console.log(`\n\u274c ${failures} failure(s)`); process.exit(1); }
console.log("\n\uD83C\uDF89 voice-turn-taking tests passed");
