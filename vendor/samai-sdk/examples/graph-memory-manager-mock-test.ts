import { createClient, createMockProvider, createSession, InMemorySessionStore, createGraphMemoryManager } from "../src/index.js";

let sessionRunCalls = 0;
let closeCalls = 0;

class FakeSession {
  async run() { sessionRunCalls += 1; return { records: [] }; }
  async close() {}
}
class FakeDriver {
  session() { return new FakeSession(); }
  async close() { closeCalls += 1; }
}

const mock = createMockProvider({ responses: [] });
const client = createClient({ provider: mock });

async function main() {
  const fakeDriver = new FakeDriver() as any;
  const manager = createGraphMemoryManager({ client, driver: fakeDriver });

  const sessionA = createSession("user-A", new InMemorySessionStore());
  const sessionB = createSession("user-B", new InMemorySessionStore());

  const memA1 = manager.getOrCreate("user-A", sessionA);
  const memA2 = manager.getOrCreate("user-A", sessionA); // same user, should be cached
  const memB = manager.getOrCreate("user-B", sessionB);

  console.log("memA1 === memA2 (cached, not recreated):", memA1 === memA2);
  console.log("memA1 === memB (different users, distinct instances):", memA1 === memB);
  console.log("manager.size():", manager.size());
  console.log("manager.has('user-A'):", manager.has("user-A"));
  console.log("manager.has('user-C'):", manager.has("user-C"));

  const [driverA, driverB, managerDriver] = await Promise.all([memA1.driverPromise, memB.driverPromise, manager.driverPromise]);
  console.log("memA1.driverPromise === manager.driverPromise === memB.driverPromise (shared):", driverA === managerDriver && driverB === managerDriver);

  if (memA1 !== memA2) throw new Error("expected getOrCreate to return the cached instance for a repeat call");
  if (memA1 === memB) throw new Error("expected distinct instances for different users");
  if (driverA !== fakeDriver || driverB !== fakeDriver) throw new Error("expected all users to share the manager's single driver");
  if (manager.size() !== 2) throw new Error(`expected 2 managed users, got ${manager.size()}`);
  if (!manager.has("user-A") || manager.has("user-C")) throw new Error("has() reporting wrong membership");

  await manager.stopAll();
  console.log("driver.close() call count after stopAll():", closeCalls);
  console.log("manager.size() after stopAll():", manager.size());

  if (closeCalls !== 1) throw new Error(`expected the shared driver to be closed exactly once, got ${closeCalls} closes`);
  if (manager.size() !== 0) throw new Error("expected cache to be cleared after stopAll()");

  console.log("\nPASS: manager shares one driver across users, caches per-user instances, and closes the driver exactly once.");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
