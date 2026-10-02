import { rmSync } from "node:fs";
import { RedisSessionStore, SqliteSessionStore, createSession } from "../src/index.js";

// ===========================================================================
// TEST 1 — SqliteSessionStore against the REAL better-sqlite3 library
// (no mocking here: this hits an actual on-disk SQLite database)
// ===========================================================================
console.log("=== TEST 1: SqliteSessionStore persists across store instances ===");

const dbPath = "./__samai_test_sessions.db";
rmSync(dbPath, { force: true });

const sqliteStoreA = new SqliteSessionStore({ path: dbPath });
const sessionA = createSession("user-42", sqliteStoreA);

await sessionA.appendMessages([{ role: "user", content: "What's the capital of France?" }]);
await sessionA.appendMessages([{ role: "assistant", content: "Paris." }]);

// Open a brand-new store instance pointed at the same file, to prove it's really durable
// and not just in-process memory.
const sqliteStoreB = new SqliteSessionStore({ path: dbPath });
const sessionBSameId = createSession("user-42", sqliteStoreB);
const reloaded = await sessionBSameId.getMessages();

console.log(`  reloaded message count: ${reloaded.length} (expected 2)`);
if (reloaded.length !== 2) throw new Error("Expected 2 persisted messages after reopening the DB file");
if (reloaded[1].content !== "Paris.") throw new Error("Persisted content did not round-trip correctly");

const sessionBDifferentId = createSession("user-99", sqliteStoreB);
const isolated = await sessionBDifferentId.getMessages();
console.log(`  different session_id sees: ${isolated.length} messages (expected 0, proving isolation)`);
if (isolated.length !== 0) throw new Error("Sessions with different IDs must not see each other's messages");

await sessionA.clear();
const afterClear = await sqliteStoreB.getMessages("user-42");
console.log(`  after clear(): ${afterClear.length} messages (expected 0)`);
if (afterClear.length !== 0) throw new Error("clear() did not remove the session row");

rmSync(dbPath, { force: true });
console.log("✅ TEST 1 passed (real better-sqlite3, real file on disk)\n");

// ===========================================================================
// TEST 2 — RedisSessionStore's store logic (key prefixing, TTL, JSON round-trip),
// verified against a lightweight fake client satisfying the same minimal interface
// RedisSessionStore expects from ioredis. This sandbox has no live Redis server to
// connect to, so this test injects a client the same way a caller would inject their
// own already-connected ioredis instance via `new RedisSessionStore({ client })` —
// exactly the supported "bring your own client" path, not a reimplementation.
// ===========================================================================
console.log("=== TEST 2: RedisSessionStore key prefixing, TTL, and isolation ===");

class FakeRedisClient {
  store = new Map<string, { value: string; expiresAt?: number }>();
  setCalls: { key: string; args: unknown[] }[] = [];

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    return entry ? entry.value : null;
  }
  async set(key: string, value: string, ...args: unknown[]): Promise<unknown> {
    this.setCalls.push({ key, args });
    const ttlIdx = args.findIndex((a) => a === "EX");
    const expiresAt = ttlIdx >= 0 ? Date.now() + Number(args[ttlIdx + 1]) * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }
  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }
}

const fakeClient = new FakeRedisClient();
const redisStore = new RedisSessionStore({ client: fakeClient, keyPrefix: "samai:test:", ttlSeconds: 3600 });
const redisSession = createSession("room-1", redisStore);

await redisSession.appendMessages([{ role: "user", content: "hi" }]);
await redisSession.appendMessages([{ role: "assistant", content: "hello!" }]);

const storedKey = [...fakeClient.store.keys()][0];
console.log(`  key used: "${storedKey}" (expected prefix "samai:test:")`);
if (storedKey !== "samai:test:room-1") throw new Error("keyPrefix was not applied correctly");

const lastSetArgs = fakeClient.setCalls.at(-1)!.args;
console.log(`  TTL applied on write: ${lastSetArgs.includes("EX")} (expected true)`);
if (!lastSetArgs.includes("EX")) throw new Error("ttlSeconds option did not translate to a Redis EX argument");

const msgs = await redisSession.getMessages();
console.log(`  round-tripped message count: ${msgs.length} (expected 2)`);
if (msgs.length !== 2) throw new Error("Expected 2 messages to round-trip through the fake Redis store");

await redisSession.clear();
const afterRedisClear = await redisStore.getMessages("room-1");
if (afterRedisClear.length !== 0) throw new Error("clear() did not remove the Redis key");

console.log("✅ TEST 2 passed\n");

console.log("🎉 All session-store tests passed");
