import { createFeedEngine } from "../src/index.js";

const queriesRun: { query: string; params: Record<string, unknown> }[] = [];

// Fake driver that behaves like a real Neo4j instance FOR THE SPECIFIC SHAPE
// OF DATA THIS TEST PLANTS — it doesn't reimplement Cypher, it hand-computes
// what the real query would return given three fake posts with known social/
// interest/engagement signals, so we can assert the resulting ORDER is right.
const fakePosts = [
  { postId: "post-A", niche: "hiking", likes: 500, socialSignal: 0, interestSignal: 0 }, // pure virality
  { postId: "post-B", niche: "hiking", likes: 10, socialSignal: 3, interestSignal: 2 },  // strong social+interest match
  { postId: "post-C", niche: "cooking", likes: 50, socialSignal: 0, interestSignal: 0 }, // irrelevant niche, no signal
];

function computeExpectedScore(p: typeof fakePosts[number], w: { social: number; interest: number; engagement: number }) {
  return p.socialSignal * w.social + p.interestSignal * w.interest + Math.log(p.likes + 1) * w.engagement;
}

class FakeSession {
  async run(query: string, params: Record<string, unknown>) {
    if (query.includes("ORDER BY score DESC")) {
      const w = {
        social: params.socialWeight as number,
        interest: params.interestWeight as number,
        engagement: params.engagementWeight as number,
      };
      const ranked = [...fakePosts]
        .map((p) => ({ ...p, score: computeExpectedScore(p, w) }))
        .sort((a, b) => b.score - a.score);
      return {
        records: ranked.map((p) => ({
          get: (k: string) => (p as any)[k],
        })),
      };
    }
    // write operations (recordLike, recordFollow, upsertPost)
    queriesRun.push({ query, params });
    return { records: [] };
  }
  async close() {}
}
class FakeDriver {
  session() { return new FakeSession(); }
  async close() {}
}

async function main() {
  const feed = createFeedEngine({ driverPromise: Promise.resolve(new FakeDriver() as any) });

  const results = await feed.getFeed({ userId: "user-123", limit: 10 });
  console.log("ranked feed:", results);

  // post-B has strong social+interest signal despite fewer likes than post-A
  // (pure virality) or post-C (irrelevant niche) — this is the actual point
  // of the hybrid model: it should NOT just be sorted by raw like count.
  if (results[0].postId !== "post-B") {
    throw new Error(`expected post-B (social+interest match) to rank first, got ${results[0].postId}`);
  }
  if (results[0].score <= results[1].score || results[1].score <= results[2].score) {
    throw new Error("expected scores to be strictly descending");
  }

  await feed.recordLike("user-123", "post-B");
  await feed.recordFollow("user-123", "user-456");
  await feed.recordFriendship("user-123", "user-789");
  await feed.upsertPost({ id: "post-D", niche: "hiking", topics: ["trail running", "gear"] });

  console.log("write queries issued:", queriesRun.map((q) => q.query.trim().split("\n")[0]));

  if (queriesRun.length !== 4) throw new Error(`expected 4 write queries, got ${queriesRun.length}`);
  if (!queriesRun[0].query.includes("MERGE (u)-[:LIKED]->(p)")) throw new Error("recordLike query wrong");
  if (!queriesRun[1].query.includes("MERGE (a)-[:FOLLOWS]->(b)")) throw new Error("recordFollow query wrong");
  if (!queriesRun[2].query.includes("FRIEND_OF]->(a)")) throw new Error("recordFriendship should be bidirectional");
  if ((queriesRun[3].params as any).topics?.length !== 2) throw new Error("upsertPost topics not passed through");

  console.log("\nPASS: hybrid scoring ranks social+interest match above raw virality, and all writes issue the right Cypher.");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
