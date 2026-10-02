import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { renderTraceHTML } from "../src/trace-viewer.js";
import { createTrace, recordEvent, addUsage, finishTrace } from "../src/trace.js";

// ===========================================================================
// TEST 1 — renderTraceHTML() produces well-formed, content-correct HTML
// ===========================================================================
console.log("=== TEST 1: renderTraceHTML() content correctness ===");

const trace = createTrace("viewer-test-run", "router");
recordEvent(trace, { type: "model-call", agentName: "router", model: "claude-sonnet-4-6", turn: 1 });
addUsage(trace, { inputTokens: 50, outputTokens: 10, totalTokens: 60 });
recordEvent(trace, { type: "model-call-completed", agentName: "router", usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } });
recordEvent(trace, { type: "tool-call", agentName: "router", toolName: "get_weather", args: { city: "Tokyo" } });
recordEvent(trace, { type: "tool-result", agentName: "router", toolName: "get_weather", isError: false });
finishTrace(trace);
recordEvent(trace, { type: "run-completed" });

const html = renderTraceHTML(trace);

console.log(`  starts with <!DOCTYPE html>: ${html.trim().startsWith("<!DOCTYPE html>")}`);
if (!html.trim().startsWith("<!DOCTYPE html>")) throw new Error("Output is not a valid HTML document");

console.log(`  contains the run id: ${html.includes("viewer-test-run")}`);
if (!html.includes("viewer-test-run")) throw new Error("Rendered HTML is missing the run id");

console.log(`  contains the agent path: ${html.includes("router")}`);
if (!html.includes("router")) throw new Error("Rendered HTML is missing the agent name");

console.log(`  contains total token count: ${html.includes("60 tokens")}`);
if (!html.includes("60 tokens")) throw new Error("Rendered HTML is missing the token usage summary");

console.log(`  contains the tool name: ${html.includes("get_weather")}`);
if (!html.includes("get_weather")) throw new Error("Rendered HTML is missing the tool call detail");

// XSS-safety: a malicious tool arg/reason shouldn't break out of the HTML
const xssTrace = createTrace("xss-test", "router");
recordEvent(xssTrace, { type: "tool-call", agentName: "router", toolName: "danger", args: { x: "</script><script>alert(1)</script>" } });
const xssHtml = renderTraceHTML(xssTrace);
const unescaped = xssHtml.includes("<script>alert(1)</script>");
console.log(`  unsanitized tool args are NOT injected raw into the page: ${!unescaped}`);
if (unescaped) throw new Error("renderTraceHTML() is vulnerable to HTML injection via event data");

console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — `samai-sdk trace <file>` actually serves the rendered page over real HTTP
// ===========================================================================
console.log("=== TEST 2: `samai-sdk trace` serves the viewer over a real HTTP server ===");

const dir = "./__trace_viewer_test";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const traceFilePath = `${dir}/trace.json`;
writeFileSync(traceFilePath, JSON.stringify(trace));

const port = 47291; // unlikely to collide
const child = execFile("node", [process.cwd() + "/dist/cli.js", "trace", traceFilePath, "--port", String(port)]);

let serverStarted = false;
child.stdout?.on("data", (chunk) => {
  if (chunk.toString().includes("Trace viewer running")) serverStarted = true;
});

// Poll for the server to come up, then fetch from it for real.
const deadline = Date.now() + 5000;
while (!serverStarted && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`  CLI reported the server started: ${serverStarted}`);
if (!serverStarted) throw new Error("CLI `trace` command did not report a running server in time");

const res = await fetch(`http://localhost:${port}`);
console.log(`  HTTP status: ${res.status} (expected 200)`);
if (res.status !== 200) throw new Error(`Expected 200 from the trace viewer server, got ${res.status}`);

const body = await res.text();
console.log(`  served page contains the run id: ${body.includes("viewer-test-run")}`);
if (!body.includes("viewer-test-run")) throw new Error("Served page is missing expected trace content");
console.log(`  content-type is text/html: ${res.headers.get("content-type")?.includes("text/html")}`);
if (!res.headers.get("content-type")?.includes("text/html")) throw new Error("Wrong content-type served");

child.kill();
rmSync(dir, { recursive: true, force: true });

console.log("✅ TEST 2 passed\n");
console.log("🎉 All trace-viewer tests passed");
