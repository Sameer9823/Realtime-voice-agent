import { trace as otelTrace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createTrace, recordEvent, addUsage, finishTrace } from "../src/trace.js";
import { exportRunTraceToOtel } from "../src/otel.js";

console.log("=== TEST: exportRunTraceToOtel() against the REAL OpenTelemetry SDK ===");

// Register a real tracer provider with an in-memory exporter — this is exactly what a host
// app does in production (swap InMemorySpanExporter for an OTLP exporter to Honeycomb/Datadog/
// etc.), so `trace.getTracer()` inside exportRunTraceToOtel() returns a REAL recording tracer,
// not a no-op stub.
const memoryExporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
});
otelTrace.setGlobalTracerProvider(provider);

// Build a realistic RunTrace by hand, covering every event type the exporter handles.
const runTrace = createTrace("test-run-otel", "router");

recordEvent(runTrace, { type: "model-call", agentName: "router", model: "claude-sonnet-4-6", turn: 1 });
addUsage(runTrace, { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
recordEvent(runTrace, { type: "model-call-completed", agentName: "router", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });

recordEvent(runTrace, { type: "tool-call", agentName: "router", toolName: "get_weather", args: { city: "Tokyo" } });
recordEvent(runTrace, { type: "tool-result", agentName: "router", toolName: "get_weather", isError: false });

recordEvent(runTrace, { type: "retry", agentName: "router", attempt: 1, delayMs: 200, error: "503" });
recordEvent(runTrace, { type: "handoff", fromAgent: "router", toAgent: "specialist", reason: "needs expertise" });
recordEvent(runTrace, { type: "guardrail-triggered", stage: "output", agentName: "specialist", reason: "schema mismatch" });

runTrace.agentPath.push("specialist");
finishTrace(runTrace);
recordEvent(runTrace, { type: "run-completed" });

await exportRunTraceToOtel(runTrace, { tracerName: "samai-sdk-test" });
await provider.forceFlush();

const spans = memoryExporter.getFinishedSpans();
const spanNames = spans.map((s) => s.name).sort();
console.log(`  total spans exported: ${spans.length}`);
console.log(`  span names: ${spanNames.join(", ")}`);

const expectedNames = ["samai.run", "samai.model_call", "samai.tool_call", "samai.retry", "samai.handoff", "samai.guardrail_triggered"].sort();
if (JSON.stringify(spanNames) !== JSON.stringify(expectedNames)) {
  throw new Error(`Expected spans [${expectedNames.join(", ")}], got [${spanNames.join(", ")}]`);
}

const rootSpan = spans.find((s) => s.name === "samai.run")!;
console.log(`  root span run_id attribute: "${rootSpan.attributes["samai.run_id"]}" (expected "test-run-otel")`);
if (rootSpan.attributes["samai.run_id"] !== "test-run-otel") throw new Error("Root span missing/wrong run_id attribute");
console.log(`  root span agent_path attribute: "${rootSpan.attributes["samai.agent_path"]}" (expected "router -> specialist")`);
if (rootSpan.attributes["samai.agent_path"] !== "router -> specialist") throw new Error("Root span agent_path is wrong");
console.log(`  root span total_tokens: ${rootSpan.attributes["samai.usage.total_tokens"]} (expected 120)`);
if (rootSpan.attributes["samai.usage.total_tokens"] !== 120) throw new Error("Root span usage attribute is wrong");

const modelCallSpan = spans.find((s) => s.name === "samai.model_call")!;
console.log(`  model_call span model attribute: "${modelCallSpan.attributes["samai.model"]}" (expected "claude-sonnet-4-6")`);
if (modelCallSpan.attributes["samai.model"] !== "claude-sonnet-4-6") throw new Error("model_call span missing model attribute");
console.log(`  model_call span input_tokens: ${modelCallSpan.attributes["samai.usage.input_tokens"]} (expected 100)`);
if (modelCallSpan.attributes["samai.usage.input_tokens"] !== 100) throw new Error("model_call span usage is wrong");

// Real parent-child relationship, not just time-overlap — every non-root span's parent must
// be the root span's own span context, proving otel.trace.setSpan(context, rootSpan) actually
// threaded through to every startSpan() call.
const rootSpanId = rootSpan.spanContext().spanId;
const nonRootSpans = spans.filter((s) => s.name !== "samai.run");
const allChildrenOfRoot = nonRootSpans.every((s) => s.parentSpanId === rootSpanId);
console.log(`  every child span's parentSpanId matches the root span: ${allChildrenOfRoot}`);
if (!allChildrenOfRoot) throw new Error("Spans are not correctly parented under samai.run — nesting is broken");

const toolCallSpan = spans.find((s) => s.name === "samai.tool_call")!;
console.log(`  tool_call span duration is non-negative and derived from real timestamps: ${toolCallSpan.duration[0] >= 0}`);
if (toolCallSpan.duration[0] < 0) throw new Error("tool_call span has a negative/invalid duration");

const handoffSpan = spans.find((s) => s.name === "samai.handoff")!;
console.log(`  handoff span reason attribute: "${handoffSpan.attributes["samai.reason"]}" (expected "needs expertise")`);
if (handoffSpan.attributes["samai.reason"] !== "needs expertise") throw new Error("handoff span reason attribute is wrong");

const guardrailSpan = spans.find((s) => s.name === "samai.guardrail_triggered")!;
console.log(`  guardrail span status is ERROR (code 2): ${guardrailSpan.status.code === 2}`);
if (guardrailSpan.status.code !== 2) throw new Error("guardrail_triggered span should have ERROR status");

console.log("✅ TEST passed\n");
console.log("🎉 OpenTelemetry export test passed against the real @opentelemetry SDK");
