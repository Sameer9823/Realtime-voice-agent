import { createClient, createMockProvider, defineAgent, createSession, InMemorySessionStore, enableGraphMemory, chatWithMemory } from "../src/index.js";

// Fake Neo4j driver injected directly via the `driver` option — no monkey-patching
// of the neo4j-driver package, which turned out to be unreliable across the
// ESM/CJS module boundary (see README notes). This actually exercises the
// code path: we record every query the tool issues and assert on it below.
const queriesRun: { query: string; params: Record<string, unknown> }[] = [];

class FakeSession {
  async run(query: string, params: Record<string, unknown>) {
    queriesRun.push({ query, params });
    return { records: [] };
  }
  async close() {}
}
class FakeDriver {
  session() { return new FakeSession(); }
  async close() {}
}

const mock = createMockProvider({
  responses: [
    { text: "Kyoto in autumn is gorgeous — want restaurant or itinerary ideas?" },
    { toolCalls: [{ toolName: "execute_cypher_query", args: { query: "MERGE (u:User {id:$userId})-[:PLANNING]->(t:Trip {city:'Kyoto'})" } }] },
    { text: "User is planning a trip to Kyoto next month." },
  ],
});

const client = createClient({ provider: mock });
const session = createSession("user-123", new InMemorySessionStore());

const memory = enableGraphMemory({
  client,
  driver: new FakeDriver() as any,
  userId: "user-123",
  session,
}).build();

const mainAgent = defineAgent({
  name: "assistant",
  instructions: "You are a helpful assistant.",
  model: "claude-sonnet-4-6",
});

async function main() {
  const first = await chatWithMemory(client, mainAgent, memory, "Planning a trip to Kyoto next month.", { session });
  console.log("assistant:", first.output);

  const context = await memory.sweepOnce();
  console.log("running context after sweep:", context);
  console.log("queries the fake driver actually received:", queriesRun);

  if (!context.includes("Kyoto")) throw new Error("sweep did not produce expected context");
  if (queriesRun.length !== 1) throw new Error(`expected exactly 1 query to reach the driver, got ${queriesRun.length}`);
  if (!queriesRun[0].query.includes("MERGE")) throw new Error("expected the tool to have actually run a MERGE query");
  if (queriesRun[0].params.userId !== "user-123") throw new Error("expected userId to be injected into query params");

  console.log("\nPASS: the tool call genuinely reached the fake driver with the expected query and params.");
  await memory.stop();
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
