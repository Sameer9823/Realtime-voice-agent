/**
 * REAL (non-mocked) test for createWebSearchTool().
 *
 * This calls the actual Tavily API over the network — no stubs, no fetch mocking.
 * Run it with:
 *
 *   TAVILY_API_KEY=tvly-xxxx npx tsx examples/real-web-search-test.ts
 *
 * or drop TAVILY_API_KEY=... into a .env file and run with `node --env-file=.env`:
 *
 *   npx tsx --env-file=.env examples/real-web-search-test.ts
 */
import { createWebSearchTool } from "../src/tools/web-search.js";

async function main() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.error("❌ Set TAVILY_API_KEY in your environment (or .env) before running this test.");
    process.exit(1);
  }

  console.log("=== REAL TEST: createWebSearchTool() against the live Tavily API ===\n");

  const tool = createWebSearchTool({ provider: "tavily", apiKey, maxResults: 5 });

  console.log(`Tool name: ${tool.name}`);
  console.log(`Tool description: ${tool.description}\n`);

  const query = "What is the latest stable version of TypeScript?";
  console.log(`Calling tool.execute({ query: ${JSON.stringify(query)} }) ...\n`);

  const start = Date.now();
  const results = await tool.execute({ query });
  const elapsedMs = Date.now() - start;

  console.log(`✅ Got ${results.length} result(s) in ${elapsedMs}ms\n`);

  for (const [i, r] of results.entries()) {
    console.log(`${i + 1}. ${r.title}`);
    console.log(`   ${r.url}`);
    console.log(`   ${r.snippet.slice(0, 140)}${r.snippet.length > 140 ? "…" : ""}\n`);
  }

  // Basic shape assertions so this fails loudly if Tavily's response shape ever changes.
  if (results.length === 0) throw new Error("Expected at least 1 result, got 0");
  for (const r of results) {
    if (!r.title || !r.url || typeof r.snippet !== "string") {
      throw new Error(`Malformed result item: ${JSON.stringify(r)}`);
    }
  }

  console.log("🎉 Real Tavily web-search test passed — tool is production-ready.");
}

main().catch((err) => {
  console.error("❌ Real web-search test FAILED:", err);
  process.exit(1);
});
