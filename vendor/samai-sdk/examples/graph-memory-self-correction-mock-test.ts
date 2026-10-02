import { createClient, createMockProvider, createSession, InMemorySessionStore, enableGraphMemory, runSelfCorrection } from "../src/index.js";

const queriesRun: string[] = [];

class FakeSession {
  async run(query: string, params: Record<string, unknown>) {
    // Order matters: check the more specific queries before the generic
    // "count(r) AS cnt" substring match, since the generic-relationship-type
    // query also contains that substring.
    if (query.includes("size(nodes) > 1")) {
      return {
        records: [
          { get: (k: string) => ({ label: "Topic", name: "kyoto trip", cnt: { toNumber: () => 2 } } as any)[k] },
        ],
      };
    }
    if (query.includes("type(r) IN $genericTypes")) {
      return {
        records: [{ get: (k: string) => ({ type: "RELATED_TO", cnt: { toNumber: () => 12 } } as any)[k] }],
      };
    }
    if (query.includes("count(r) AS cnt") && query.includes("->()")) {
      return { records: [{ get: (k: string) => (k === "cnt" ? { toNumber: () => 250 } : undefined) }] };
    }
    // a curator fix-it call
    queriesRun.push(query);
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
    {
      toolCalls: [
        { toolName: "execute_cypher_query", args: { query: "MATCH (a:Topic {name:'Kyoto Trip'}), (b:Topic {name:'kyoto trip'}) DETACH DELETE b" } },
      ],
    },
    { text: "Merged 2 duplicate Topic nodes, renamed 12 RELATED_TO edges to specific types." },
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

async function main() {
  const report = await runSelfCorrection({ memory, maxRelationships: 200 });

  console.log("total relationships:", report.totalRelationships);
  console.log("duplicate groups:", report.duplicateNodeGroups);
  console.log("generic relationship types:", report.genericRelationshipCounts);
  console.log("curator ran:", report.curatorRan);
  console.log("curator summary:", report.curatorSummary);
  console.log("fix-it queries the fake driver actually received:", queriesRun);

  if (!report.curatorRan) throw new Error("expected curator to run given planted problems");
  if (report.duplicateNodeGroups.length !== 1) throw new Error("expected 1 duplicate group detected");
  if (report.duplicateNodeGroups[0].name !== "kyoto trip") throw new Error("duplicate group name mismatch");
  if (report.genericRelationshipCounts.length !== 1) throw new Error("expected 1 generic rel type detected");
  if (report.genericRelationshipCounts[0].type !== "RELATED_TO") throw new Error("generic rel type value mismatch");
  if (report.totalRelationships !== 250) throw new Error("expected relationship count to be read correctly");
  if (queriesRun.length !== 1) throw new Error(`expected exactly 1 curator fix-it query, got ${queriesRun.length}`);
  if (!queriesRun[0].includes("DETACH DELETE")) throw new Error("expected the curator's actual fix query to reach the driver");

  console.log("\nPASS: self-correction detected all three planted problems and the curator's fix genuinely reached the driver.");
  await memory.stop();
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
