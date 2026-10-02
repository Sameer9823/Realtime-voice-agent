import { createUpsertFactTool, applyRecencyDecay } from "../src/index.js";

const queriesRun: { query: string; params: Record<string, unknown> }[] = [];

class FakeSession {
  async run(query: string, params: Record<string, unknown>) {
    queriesRun.push({ query, params });
    if (query.includes("DELETE r\n             RETURN count(r) AS deleted")) {
      return { records: [{ get: (k: string) => (k === "deleted" ? 1 : undefined) }] };
    }
    return { records: [] };
  }
  async close() {}
}
class FakeDriver {
  session() { return new FakeSession(); }
  async close() {}
}

// --- upsert_fact: basic write is timestamped ---
async function testBasicUpsert() {
  queriesRun.length = 0;
  const tool = createUpsertFactTool(Promise.resolve(new FakeDriver() as any), "user-123");
  const result = await (tool as any).execute({ relation: "LIKES", objectLabel: "Topic", objectName: "hiking" });

  console.log("basic upsert result:", result);
  console.log("query:", queriesRun[0].query);

  if (queriesRun.length !== 1) throw new Error(`expected exactly 1 query, got ${queriesRun.length}`);
  if (!queriesRun[0].query.includes("MERGE (u)-[rel:LIKES]->(o)")) throw new Error("relation not embedded correctly");
  if (!queriesRun[0].query.includes("MERGE (o:Topic {name: $objectName})")) throw new Error("label not embedded correctly");
  if (!queriesRun[0].query.includes("rel.updatedAt = timestamp()")) throw new Error("missing timestamp write");
  if (result.retiredFacts !== 0) throw new Error("expected no retirements on a plain write");

  console.log("PASS: basic upsert_fact writes a timestamped edge with the right relation/label.\n");
}

// --- upsert_fact: contradiction retirement ---
async function testContradiction() {
  queriesRun.length = 0;
  const tool = createUpsertFactTool(Promise.resolve(new FakeDriver() as any), "user-123");
  const result = await (tool as any).execute({
    relation: "DISLIKES",
    objectLabel: "Topic",
    objectName: "hiking",
    contradicts: ["LIKES"],
  });

  console.log("contradiction result:", result);
  console.log("queries issued:", queriesRun.map((q) => q.query.split("\n")[0]));

  if (queriesRun.length !== 2) throw new Error(`expected 2 queries (retire + write), got ${queriesRun.length}`);
  if (!queriesRun[0].query.includes("MATCH (u:User {id: $userId})-[r:LIKES]->")) throw new Error("retirement query wrong relation");
  if (!queriesRun[1].query.includes("MERGE (u)-[rel:DISLIKES]->(o)")) throw new Error("new fact not written after retirement");
  if (result.retiredFacts !== 1) throw new Error("expected retiredFacts: 1 (the fake driver reports 1 deleted)");

  console.log("PASS: contradicting old fact is retired BEFORE the new one is written, in the right order.\n");
}

// --- upsert_fact: injection safety ---
async function testInjectionRejected() {
  queriesRun.length = 0;
  const tool = createUpsertFactTool(Promise.resolve(new FakeDriver() as any), "user-123");
  const malicious = "LIKES]->(o) DETACH DELETE o WITH 1 as x MATCH (x:Anything";

  let threw = false;
  try {
    await (tool as any).execute({ relation: malicious, objectLabel: "Topic", objectName: "hiking" });
  } catch (err) {
    threw = true;
    console.log("correctly rejected:", (err as Error).message);
  }
  if (!threw) throw new Error("expected malicious relation string to be rejected, not executed");
  if (queriesRun.length !== 0) throw new Error("no query should have reached the driver for a rejected identifier");

  console.log("PASS: relation-type injection attempt rejected before touching the driver.\n");
}

// --- applyRecencyDecay: actual math on planted ages ---
async function testDecay() {
  const now = Date.now();
  const DAY = 86_400_000;

  // rel-fresh: 5 days old, halfLife 30 -> weight = 0.5^(5/30) ≈ 0.891 -> kept, reweighted
  // rel-old: 200 days old, halfLife 30 -> weight = 0.5^(200/30) ≈ 0.0000... -> pruned
  // rel-boundary: exactly at half-life (30 days) -> weight = 0.5 -> kept
  const planted = [
    { relId: "rel-fresh", updatedAt: now - 5 * DAY },
    { relId: "rel-old", updatedAt: now - 200 * DAY },
    { relId: "rel-boundary", updatedAt: now - 30 * DAY },
  ];

  const decayQueries: { query: string; params: any }[] = [];
  class DecaySession {
    async run(query: string, params: any) {
      if (query.includes("RETURN elementId(r) AS relId")) {
        return { records: planted.map((p) => ({ get: (k: string) => (p as any)[k] })) };
      }
      decayQueries.push({ query, params });
      return { records: [] };
    }
    async close() {}
  }
  class DecayDriver {
    session() { return new DecaySession(); }
    async close() {}
  }

  const report = await applyRecencyDecay({
    driverPromise: Promise.resolve(new DecayDriver() as any),
    userId: "user-123",
    halfLifeDays: 30,
    pruneThreshold: 0.05,
  });

  console.log("decay report:", report);
  console.log("reweight query params:", decayQueries[0]?.params);
  console.log("prune query params:", decayQueries[1]?.params);

  if (report.scored !== 2) throw new Error(`expected 2 facts kept/reweighted (fresh + boundary), got ${report.scored}`);
  if (report.pruned !== 1) throw new Error(`expected 1 fact pruned (the 200-day-old one), got ${report.pruned}`);

  const reweighted = decayQueries[0].params.items as { relId: string; weight: number }[];
  const freshWeight = reweighted.find((i) => i.relId === "rel-fresh")!.weight;
  const boundaryWeight = reweighted.find((i) => i.relId === "rel-boundary")!.weight;
  if (Math.abs(freshWeight - 0.891) > 0.01) throw new Error(`fresh weight math wrong: got ${freshWeight}`);
  if (Math.abs(boundaryWeight - 0.5) > 0.01) throw new Error(`boundary weight math wrong: got ${boundaryWeight}`);

  const prunedIds = decayQueries[1].params.ids as string[];
  if (!prunedIds.includes("rel-old") || prunedIds.length !== 1) throw new Error("wrong relationship pruned");

  console.log("PASS: decay correctly computes exponential weight per fact and prunes only the one past threshold.\n");
}

async function main() {
  await testBasicUpsert();
  await testContradiction();
  await testInjectionRejected();
  await testDecay();
  console.log("ALL PASS");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
