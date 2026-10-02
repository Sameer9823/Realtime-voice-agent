/**
 * A tiny real MCP server, spoken over stdio, used purely as a test fixture for
 * `examples/mcp-usage-test.ts`. Not part of the published package — it's spawned as a child
 * process by `createMCPClient({ transport: { transport: "stdio", ... } })` so that test can
 * exercise the real MCP wire protocol end-to-end instead of mocking it.
 *
 * Exposes three tools:
 *  - "add": takes two numbers, returns their sum as structured content.
 *  - "greet": takes a name, returns a plain text greeting.
 *  - "fail": always returns an MCP tool error, to exercise the client's isError -> thrown Error path.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "samai-sdk-test-server", version: "1.0.0" });

server.registerTool(
  "add",
  {
    description: "Adds two numbers together",
    inputSchema: { a: z.number().describe("First number"), b: z.number().describe("Second number") },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
    structuredContent: { sum: a + b },
  })
);

server.registerTool(
  "greet",
  {
    description: "Returns a friendly greeting for the given name",
    inputSchema: { name: z.string().describe("Name to greet") },
  },
  async ({ name }) => ({
    content: [{ type: "text", text: `Hello, ${name}!` }],
  })
);

server.registerTool(
  "fail",
  { description: "Always fails, to test error propagation", inputSchema: {} },
  async () => ({
    content: [{ type: "text", text: "deliberate failure for testing" }],
    isError: true,
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
