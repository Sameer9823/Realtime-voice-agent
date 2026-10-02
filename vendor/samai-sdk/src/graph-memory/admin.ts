import type { Neo4jDriver } from "./graph-memory.js";

/**
 * These take an already-resolved driver, not a driverPromise — unlike the
 * hot-path modules (feed-engine, self-correction, fact-lifecycle), these are
 * one-off calls, so the caller just does `await memory.driverPromise` once
 * before calling, e.g. `ensureGraphConstraints(await memory.driverPromise)`.
 *
 * DB-level uniqueness constraints for the node types this plugin writes
 * (User, Topic, Post). These exist specifically to close the race condition
 * self-correction.ts otherwise has to clean up after the fact: two concurrent
 * sweeps for the same user can both MATCH-miss on "does this Topic exist?"
 * at the same instant and both MERGE-create it, producing a duplicate before
 * either write is visible to the other. A uniqueness constraint makes the
 * second write fail loudly instead of silently creating a duplicate.
 *
 * Safe to call on every app startup — `IF NOT EXISTS` makes it a no-op if
 * the constraint is already there.
 */
export async function ensureGraphConstraints(driver: Neo4jDriver): Promise<{ constraint: string; ok: boolean }[]> {
  const statements = [
    { name: "user_id_unique", cypher: "CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE" },
    { name: "topic_name_unique", cypher: "CREATE CONSTRAINT topic_name_unique IF NOT EXISTS FOR (t:Topic) REQUIRE t.name IS UNIQUE" },
    { name: "post_id_unique", cypher: "CREATE CONSTRAINT post_id_unique IF NOT EXISTS FOR (p:Post) REQUIRE p.id IS UNIQUE" },
  ];

  const results: { constraint: string; ok: boolean }[] = [];
  for (const stmt of statements) {
    const session = driver.session();
    try {
      await session.run(stmt.cypher);
      results.push({ constraint: stmt.name, ok: true });
    } catch (err) {
      console.error(`[admin] failed to ensure constraint ${stmt.name}:`, err);
      results.push({ constraint: stmt.name, ok: false });
    } finally {
      await session.close();
    }
  }
  return results;
}

export interface DeleteUserGraphOptions {
  /**
   * When true, also deletes neighbor nodes (Topics, Posts, etc.) that become
   * orphaned once this user's relationships are removed — i.e. nodes with no
   * remaining relationships to anything else. Shared nodes (a Topic other
   * users are also connected to) are left alone either way.
   * Default false: only the User node and its own relationships are removed,
   * which is enough to satisfy "no more of this person's data" — leftover
   * generic nodes like a Topic named "hiking" aren't personal data by
   * themselves.
   */
  deep?: boolean;
}

export interface DeleteUserGraphResult {
  deletedUser: boolean;
  orphansDeleted: number;
}

/**
 * Right-to-be-forgotten. Deletes a user's node and every relationship
 * touching it. With `deep: true`, also removes any neighbor left with zero
 * remaining relationships afterward (e.g. a Trip node only that user ever
 * touched) — but never touches a node still connected to someone else.
 */
export async function deleteUserGraph(
  driver: Neo4jDriver,
  userId: string,
  options: DeleteUserGraphOptions = {}
): Promise<DeleteUserGraphResult> {
  const session = driver.session();
  try {
    if (!options.deep) {
      const result = await session.run(`MATCH (u:User {id: $userId}) DETACH DELETE u RETURN count(u) AS deleted`, {
        userId,
      });
      const deleted = toNum(result.records[0]?.get("deleted"));
      return { deletedUser: deleted > 0, orphansDeleted: 0 };
    }

    const result = await session.run(
      `MATCH (u:User {id: $userId})
       OPTIONAL MATCH (u)--(n)
       WITH u, collect(DISTINCT n) AS neighbors
       DETACH DELETE u
       WITH neighbors
       UNWIND neighbors AS n
       WITH n WHERE n IS NOT NULL AND NOT (n)--()
       DELETE n
       RETURN count(n) AS orphansDeleted`,
      { userId }
    );
    const orphansDeleted = toNum(result.records[0]?.get("orphansDeleted"));
    return { deletedUser: true, orphansDeleted };
  } finally {
    await session.close();
  }
}

function toNum(v: unknown): number {
  if (v && typeof v === "object" && "toNumber" in (v as any)) return (v as any).toNumber();
  return typeof v === "number" ? v : Number(v ?? 0);
}
