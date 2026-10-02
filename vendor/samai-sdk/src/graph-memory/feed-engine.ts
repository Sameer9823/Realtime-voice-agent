import type { Neo4jDriver } from "./graph-memory.js";
import type { MetricsCollector } from "./metrics.js";

/**
 * Feed ranking, built the way the market actually does it in 2026: not pure
 * follow-graph (Instagram/LinkedIn/X have all moved off that), and not pure
 * engagement-count either — a hybrid of social proximity, interest-graph
 * affinity, and engagement, blended into one score. See README for sources.
 *
 * Reuses the SAME per-user graph that graph-memory.ts writes to — a post's
 * relevance to a user is scored partly from the :INTERESTED_IN edges the
 * private memory agent already wrote, so the feed gets better as the memory
 * graph gets better, same "gets more personal over time" idea from the sketch.
 */

export interface FeedEngineOptions {
  driverPromise: Promise<Neo4jDriver>;
  /** relative weight of "people you follow/are friends with also liked this", default 2 */
  socialWeight?: number;
  /** relative weight of "matches a topic you're interested in", default 3 */
  interestWeight?: number;
  /** relative weight of raw engagement (log-scaled so viral posts don't dominate everything), default 1 */
  engagementWeight?: number;
  /** optional shared metrics collector, see metrics.ts */
  metrics?: MetricsCollector;
}

export interface FeedItem {
  postId: string;
  niche: string;
  likes: number;
  socialSignal: number;
  interestSignal: number;
  score: number;
}

export interface GetFeedOptions {
  userId: string;
  limit?: number;
}

export interface FeedEngine {
  /** ranked candidate posts for this user, hybrid-scored */
  getFeed(options: GetFeedOptions): Promise<FeedItem[]>;
  /** records a like: creates the edge and increments the post's like count */
  recordLike(userId: string, postId: string): Promise<void>;
  /** creates a directed FOLLOWS edge, the social-graph signal from the sketch */
  recordFollow(followerId: string, followeeId: string): Promise<void>;
  /** creates a symmetric FRIEND_OF edge (both directions), the other social-graph signal from the sketch */
  recordFriendship(userIdA: string, userIdB: string): Promise<void>;
  /** upserts a post node with a niche tag and optional topic links for interest-graph matching */
  upsertPost(post: { id: string; niche: string; topics?: string[] }): Promise<void>;
}

export function createFeedEngine(options: FeedEngineOptions): FeedEngine {
  const { driverPromise, socialWeight = 2, interestWeight = 3, engagementWeight = 1, metrics } = options;

  return {
    async getFeed({ userId, limit = 20 }: GetFeedOptions): Promise<FeedItem[]> {
      const t0 = Date.now();
      const driver = await driverPromise;
      const session = driver.session();
      try {
        const result = await session.run(
          `MATCH (u:User {id: $userId})
           MATCH (p:Post)
           WHERE NOT (u)-[:LIKED]->(p)
           OPTIONAL MATCH (u)-[:FOLLOWS|FRIEND_OF]->(friend:User)-[:LIKED]->(p)
           WITH u, p, count(DISTINCT friend) AS socialSignal
           OPTIONAL MATCH (u)-[:INTERESTED_IN]->(t:Topic)<-[:ABOUT]-(p)
           WITH u, p, socialSignal, count(DISTINCT t) AS interestSignal
           WITH p, socialSignal, interestSignal,
                (socialSignal * $socialWeight
                 + interestSignal * $interestWeight
                 + log(coalesce(p.likes, 0) + 1) * $engagementWeight) AS score
           RETURN p.id AS postId, p.niche AS niche, coalesce(p.likes, 0) AS likes,
                  socialSignal, interestSignal, score
           ORDER BY score DESC
           LIMIT $limit`,
          { userId, socialWeight, interestWeight, engagementWeight, limit: neoInt(limit) }
        );
        return result.records.map((r) => ({
          postId: String(r.get("postId")),
          niche: String(r.get("niche")),
          likes: toNum(r.get("likes")),
          socialSignal: toNum(r.get("socialSignal")),
          interestSignal: toNum(r.get("interestSignal")),
          score: toNum(r.get("score")),
        }));
      } finally {
        await session.close();
        metrics?.recordFeedQuery(Date.now() - t0);
      }
    },

    async recordLike(userId: string, postId: string): Promise<void> {
      const driver = await driverPromise;
      const session = driver.session();
      try {
        await session.run(
          `MATCH (u:User {id: $userId}), (p:Post {id: $postId})
           MERGE (u)-[:LIKED]->(p)
           SET p.likes = coalesce(p.likes, 0) + 1`,
          { userId, postId }
        );
      } finally {
        await session.close();
      }
    },

    async recordFollow(followerId: string, followeeId: string): Promise<void> {
      const driver = await driverPromise;
      const session = driver.session();
      try {
        await session.run(
          `MERGE (a:User {id: $followerId})
           MERGE (b:User {id: $followeeId})
           MERGE (a)-[:FOLLOWS]->(b)`,
          { followerId, followeeId }
        );
      } finally {
        await session.close();
      }
    },

    async recordFriendship(userIdA: string, userIdB: string): Promise<void> {
      const driver = await driverPromise;
      const session = driver.session();
      try {
        await session.run(
          `MERGE (a:User {id: $userIdA})
           MERGE (b:User {id: $userIdB})
           MERGE (a)-[:FRIEND_OF]->(b)
           MERGE (b)-[:FRIEND_OF]->(a)`,
          { userIdA, userIdB }
        );
      } finally {
        await session.close();
      }
    },

    async upsertPost(post: { id: string; niche: string; topics?: string[] }): Promise<void> {
      const driver = await driverPromise;
      const session = driver.session();
      try {
        await session.run(
          `MERGE (p:Post {id: $id})
           SET p.niche = $niche
           WITH p
           UNWIND $topics AS topicName
           MERGE (t:Topic {name: topicName})
           MERGE (p)-[:ABOUT]->(t)`,
          { id: post.id, niche: post.niche, topics: post.topics ?? [] }
        );
      } finally {
        await session.close();
      }
    },
  };
}

// Neo4j's JS driver wants integers as its own Integer type for LIMIT — plain
// numbers work in recent driver versions too, but this keeps it explicit and
// avoids a silent float-vs-int mismatch on older driver versions.
function neoInt(n: number): number {
  return Math.trunc(n);
}

function toNum(v: unknown): number {
  if (v && typeof v === "object" && "toNumber" in (v as any)) return (v as any).toNumber();
  return typeof v === "number" ? v : Number(v);
}
