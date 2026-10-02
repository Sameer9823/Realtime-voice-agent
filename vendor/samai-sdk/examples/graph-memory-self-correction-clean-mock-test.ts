import { createClient, createMockProvider, createSession, InMemorySessionStore, enableGraphMemory, runSelfCorrection } from "../src/index.js";

// A clean graph: low relationship count, no duplicates, no generic types.
// The curator agent has zero mock responses queued — if runSelfCorrection
// calls it anyway, this test fails with "no more mock responses" or similar.
class FakeSession {
  async run(query: string) {
    if (query.includes("size(nodes) > 1")) return { records: [] };
    if (query.includes("type(r) IN $genericTypes")) return { records: [] };
    if (query.includes("count(r) AS cnt") && query.includes("->()")) {
      return { records: [{ get: (k: string) => (k === "cnt" ? { toNumber: () => 12 } : undefined) }] };
    }
    throw new Error("unexpected query in clean-graph test: " + query);
  }
  async close() {}
}
class FakeDriver {
  session() { return new FakeSession(); }
  async close() {}
}

const mock = createMockProvider({ responses: [] }); // no responses queued on purpose
const client = createClient({ provider: mock });
const session = createSession("user-123", new InMemorySessionStore());

const memory = enableGraphMemory({
  client,
  driver: new FakeDriver() as any,
  userId: "user-123",
  session,
}).build();

async function main() {
  const report = await runSelfCorrection({ memory, maxRelationships: 200 });

  console.log("total relationships:", report.totalRelationships);
  console.log("curator ran:", report.curatorRan);

  if (report.curatorRan) throw new Error("curator should NOT run on a clean graph");
  if (report.curatorSummary !== null) throw new Error("expected no curator summary on a clean graph");

  console.log("\nPASS: clean graph correctly skipped the curator entirely.");
  await memory.stop();
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
