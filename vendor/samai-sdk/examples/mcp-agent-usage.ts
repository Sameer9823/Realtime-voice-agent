/**
 * Shows the intended real-world usage pattern: pulling tools from an MCP server and handing
 * them to an agent alongside a normal, locally-defined tool. Requires a live ANTHROPIC_API_KEY
 * and the optional `@modelcontextprotocol/sdk` peer dependency — this isn't run in CI, it's
 * documentation you can copy from.
 *
 * Run with: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/mcp-agent-usage.ts
 */
import { z } from "zod";
import { createClient, anthropic, defineAgent, runAgent, createMCPClient } from "../src/index.js";

async function main() {
  // Connect to a local filesystem MCP server, scoped to /tmp. Swap this for
  // { transport: "http", url: "https://mcp.example.com/mcp", headers: {...} } to talk to a
  // remote server instead — the rest of this example is unaffected either way.
  const filesystem = createMCPClient({
    transport: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
    toolPrefix: "fs",
  });

  const client = createClient({ provider: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) });

  const getTime = {
    name: "get_time",
    description: "Get the current time",
    parameters: z.object({}),
    execute: async () => new Date().toISOString(),
  };

  const agent = defineAgent({
    name: "file_assistant",
    instructions:
      "You help the user inspect and organize files in /tmp. You have filesystem tools " +
      "(prefixed fs__) and a get_time tool. Use them as needed.",
    model: "claude-sonnet-4-6",
    // Mix MCP-derived tools with a plain local tool in the same list — from the agent's
    // perspective they're indistinguishable, both are just ToolDefinitions.
    tools: [...(await filesystem.tools()), getTime],
  });

  const result = await runAgent(client, agent, "What files are in /tmp right now, and what time is it?");

  console.log(result.text);

  // Always close MCP clients when you're done with them — for a stdio transport this
  // terminates the spawned server process.
  await filesystem.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
