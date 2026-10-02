/**
 * REAL (non-mocked) end-to-end test for createMCPClient().
 *
 * Spawns `examples/fixtures/mcp-test-server.ts` as a real child process and speaks the actual
 * MCP wire protocol over stdio — no stubs, no fake transport. Verifies: tool discovery, JSON
 * Schema passthrough (rawJsonSchema), successful structured-content + text-only calls, error
 * propagation from an MCP `isError` result, and toolPrefix collision-avoidance.
 *
 * Run with: npx tsx examples/mcp-usage-test.ts
 */
import { createMCPClient } from "../src/mcp.js";
import { toolParametersJsonSchema } from "../src/schema-adapter.js";

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures++;
  }
}

async function main() {
  console.log("=== TEST: createMCPClient() against a real stdio MCP server ===");

  const client = createMCPClient({
    transport: {
      transport: "stdio",
      command: process.execPath, // node
      args: ["--import", "tsx", "examples/fixtures/mcp-test-server.ts"],
    },
    toolPrefix: "fixture",
    timeoutMs: 10_000,
  });

  try {
    const tools = await client.tools();
    console.log(`  discovered ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

    check("discovers all 3 tools", tools.length === 3);
    check(
      "tool names are prefixed with toolPrefix",
      tools.every((t) => t.name.startsWith("fixture__"))
    );

    const addTool = tools.find((t) => t.name === "fixture__add");
    const greetTool = tools.find((t) => t.name === "fixture__greet");
    const failTool = tools.find((t) => t.name === "fixture__fail");

    check("finds the add tool", !!addTool);
    check("finds the greet tool", !!greetTool);
    check("finds the fail tool", !!failTool);

    if (addTool) {
      check("add tool carries description from the server", addTool.description === "Adds two numbers together");

      // rawJsonSchema should be the server's real JSON Schema, not a zod-derived stub.
      const schema = toolParametersJsonSchema(addTool) as { type?: string; properties?: Record<string, unknown> };
      check("rawJsonSchema round-trips through toolParametersJsonSchema()", schema.type === "object");
      check("rawJsonSchema has both 'a' and 'b' properties", !!schema.properties?.a && !!schema.properties?.b);

      // parameters is a permissive passthrough validator (real validation happens server-side).
      const parsed = addTool.parameters.parse({ a: 2, b: 3 });
      check("passthrough parameters() accepts an args object", !!parsed);

      const sum = await addTool.execute({ a: 2, b: 3 });
      console.log(`  add(2, 3) -> ${JSON.stringify(sum)}`);
      check("add() returns structuredContent when the server provides it", (sum as { sum: number }).sum === 5);
    }

    if (greetTool) {
      const greeting = await greetTool.execute({ name: "Ada" });
      console.log(`  greet("Ada") -> ${JSON.stringify(greeting)}`);
      check("greet() flattens a text-only content block into a plain string", greeting === "Hello, Ada!");
    }

    if (failTool) {
      let threw = false;
      let message = "";
      try {
        await failTool.execute({});
      } catch (err) {
        threw = true;
        message = err instanceof Error ? err.message : String(err);
      }
      console.log(`  fail() threw: ${message}`);
      check("fail() (isError: true) surfaces as a thrown Error", threw);
      check("thrown Error carries the server's error text", message.includes("deliberate failure"));
    }
  } finally {
    await client.close();
    console.log("  client closed");
  }

  console.log(failures === 0 ? "\n✅ All MCP client tests passed" : `\n❌ ${failures} MCP client test(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ Uncaught error:", err);
  process.exit(1);
});
