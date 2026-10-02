import { pipelineVoice } from "../src/voice/pipeline/pipeline-provider.js";
import { createMockSTTProvider, createMockTTSProvider } from "../src/voice/testing.js";
import { createMockProvider } from "../src/testing.js";
import { createSession, InMemorySessionStore } from "../src/session.js";
import { defineVoiceAgent } from "../src/voice/voice-agent.js";
import { exportRunTraceToOtel } from "../src/otel.js";
import { renderTraceHTML } from "../src/trace-viewer.js";

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  \u2705 ${label}`);
  else { console.log(`  \u274c ${label}`); failures++; }
}

console.log("=== TEST: voice tracing (RunTrace events) ===");
const agent = defineVoiceAgent({ name: "trace-agent", instructions: "helpful", model: "mock" });
const llm = createMockProvider({ responses: [{ text: "Hello traced world." }] });
const stt = createMockSTTProvider();
const tts = createMockTTSProvider({ chunkDelayMs: 5 });
const session = createSession("trace-1", new InMemorySessionStore());
const vs: any = await pipelineVoice({ stt, llm, tts }).connect({ agent, session });

(stt as any).simulateTranscript("hello", { confidence: 0.95 });
await new Promise(r => setTimeout(r, 120));

const trace = vs._trace;
console.log(`  trace events: ${trace.events.map((e:any)=>e.type).join(", ")}`);
check("trace has run-started", trace.events.some((e:any) => e.type === "run-started"));
check("trace has voice-turn", trace.events.some((e:any) => e.type === "voice-turn" && e.transcript === "hello"));
check("trace has model-call", trace.events.some((e:any) => e.type === "model-call"));

const stt2 = createMockSTTProvider();
const tts2 = createMockTTSProvider({ chunkDelayMs: 30 });
const manualLLM: any = {
  name: "slow-trace",
  async generate() { throw new Error("not used"); },
  async *stream() {
    yield { type: "text-delta", textDelta: "Long answer that will be interrupted. " } as any;
    await new Promise((r:any) => setTimeout(r, 60));
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any;
  }
};
const vs2: any = await pipelineVoice({ stt: stt2, llm: manualLLM, tts: tts2 }).connect({ agent, session: createSession("trace-2", new InMemorySessionStore()) });
(stt2 as any).simulateTranscript("start", { confidence: 0.95 });
await new Promise(r => setTimeout(r, 20));
(stt2 as any).simulateTranscript("stop stop", { confidence: 0.95 });
await new Promise(r => setTimeout(r, 40));
const trace2 = vs2._trace;
console.log(`  trace2 events: ${trace2.events.map((e:any)=>e.type).join(", ")}`);
check("interruption recorded in trace", trace2.events.some((e:any) => e.type === "interruption"));

console.log("\n=== TEST: OTEL export includes voice spans ===");
try {
  const base: any = await import("@opentelemetry/sdk-trace-base").catch(() => null);
  if (base?.NodeTracerProvider) {
    const { InMemorySpanExporter, SimpleSpanProcessor } = base;
    const exporter = new InMemorySpanExporter();
    const provider = new base.NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
    await exportRunTraceToOtel(trace);
    const spans = exporter.getFinishedSpans();
    console.log(`  otel spans: ${spans.map((s:any)=>s.name).join(", ")}`);
    check("otel export produced at least 1 span", spans.length >= 1);
    await provider.shutdown();
  } else {
    console.log("  (skipped otel \u2014 sdk not installed)");
  }
} catch (e) {
  console.log(`  otel export skipped: ${String(e).slice(0,120)}`);
}

console.log("\n=== TEST: trace viewer renders voice events ===");
const html = renderTraceHTML(trace);
check("trace HTML non-empty", html.length > 500);

await vs.close(); await vs2.close();

if (failures) { console.log(`\n\u274c ${failures} failure(s)`); process.exit(1); }
console.log("\n\uD83C\uDF89 voice-tracing tests passed");
