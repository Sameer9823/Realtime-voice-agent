import { ensureGraphConstraints, deleteUserGraph } from "../src/index.js";

const constraintQueries: string[] = [];

class ConstraintFakeSession {
  async run(query: string) {
    constraintQueries.push(query);
    return { records: [] };
  }
  async close() {}
}
class ConstraintFakeDriver {
  session() { return new ConstraintFakeSession(); }
  async close() {}
}

async function testConstraints() {
  const results = await ensureGraphConstraints(new ConstraintFakeDriver() as any);

  console.log("constraint queries issued:", constraintQueries);
  console.log("results:", results);

  if (constraintQueries.length !== 3) throw new Error(`expected 3 constraint statements, got ${constraintQueries.length}`);
  if (!constraintQueries[0].includes("FOR (u:User) REQUIRE u.id IS UNIQUE")) throw new Error("User constraint wrong");
  if (!constraintQueries[1].includes("FOR (t:Topic) REQUIRE t.name IS UNIQUE")) throw new Error("Topic constraint wrong");
  if (!constraintQueries[2].includes("FOR (p:Post) REQUIRE p.id IS UNIQUE")) throw new Error("Post constraint wrong");
  if (!results.every((r) => r.ok)) throw new Error("expected all constraints to report ok");

  console.log("PASS: all 3 uniqueness constraints issued correctly.\n");
}

// --- deleteUserGraph: shallow mode ---

class ShallowFakeSession {
  async run(query: string, params: Record<string, unknown>) {
    if (!query.includes("DETACH DELETE u")) throw new Error("shallow delete should only run one DETACH DELETE query");
    return { records: [{ get: (k: string) => (k === "deleted" ? 1 : undefined) }] };
  }
  async close() {}
}
class ShallowFakeDriver {
  session() { return new ShallowFakeSession(); }
  async close() {}
}

async function testShallowDelete() {
  const result = await deleteUserGraph(new ShallowFakeDriver() as any, "user-123");
  console.log("shallow delete result:", result);
  if (!result.deletedUser) throw new Error("expected deletedUser: true");
  if (result.orphansDeleted !== 0) throw new Error("shallow mode should never report orphan deletions");
  console.log("PASS: shallow delete removes only the user node.\n");
}

// --- deleteUserGraph: deep mode, distinguishing orphaned vs shared nodes ---
//
// Scenario: user-123 has a Trip node only they touch (should be deleted as an
// orphan) AND is INTERESTED_IN a Topic "hiking" that user-456 also likes
// (should survive, since (n)--() is still true for it after user-123 is gone).

class DeepFakeSession {
  async run(query: string, params: Record<string, unknown>) {
    if (!query.includes("UNWIND neighbors")) throw new Error("unexpected query in deep delete test");
    // A fake driver can only prove we SEND the right query — it can't prove Neo4j's
    // actual graph semantics execute it correctly, since that's real database logic,
    // not something to fake. So we assert the protective filter is actually present
    // in the query text: "NOT (n)--()" is what keeps a still-shared node (like a
    // Topic other users are also connected to) from being deleted.
    if (!query.includes("NOT (n)--()")) throw new Error("query is missing the shared-node protection filter");
    return { records: [{ get: (k: string) => (k === "orphansDeleted" ? 1 : undefined) }] };
  }
  async close() {}
}
class DeepFakeDriver {
  session() { return new DeepFakeSession(); }
  async close() {}
}

async function testDeepDelete() {
  const result = await deleteUserGraph(new DeepFakeDriver() as any, "user-123", { deep: true });
  console.log("deep delete result:", result);
  if (!result.deletedUser) throw new Error("expected deletedUser: true");
  if (result.orphansDeleted !== 1) throw new Error("expected exactly 1 orphan deleted (the Trip node, not the shared Topic)");
  console.log("PASS: deep delete's query includes the shared-node protection filter, and correctly maps the returned count.\n");
}

async function main() {
  await testConstraints();
  await testShallowDelete();
  await testDeepDelete();
  console.log("ALL PASS");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
