import {
  enableGraphMemory,
  loadNeo4jDriver,
  type GraphMemory,
  type MinimalSession,
  type Neo4jCreds,
  type Neo4jDriver,
} from "./graph-memory.js";
import { createFeedEngine, type FeedEngine } from "./feed-engine.js";
import type { MetricsCollector } from "./metrics.js";

/**
 * Why this exists: enableGraphMemory({ creds, ... }) creates its own Driver —
 * fine for one user, wasteful for many. Neo4j's driver already does internal
 * connection pooling *within* a Driver instance; the actual fix for many
 * users isn't a bigger pool, it's not creating N separate Drivers (and N
 * separate connection pools) for N users in the first place.
 *
 * createGraphMemoryManager() creates ONE Driver, shares it across every
 * user's GraphMemory (via the `driver` injection option graph-memory.ts
 * already supports), and caches per-user instances so calling getOrCreate()
 * twice for the same user doesn't spin up a second background sweep timer.
 */

export interface GraphMemoryManagerOptions {
  client: any;
  creds?: Neo4jCreds;
  driver?: Neo4jDriver | Promise<Neo4jDriver>;
  model?: string;
  intervalMs?: number;
  windowSize?: number;
  metrics?: MetricsCollector;
}

export interface GraphMemoryManager {
  /** resolves to the single shared driver — await this, then pass to ensureGraphConstraints() once at startup */
  driverPromise: Promise<Neo4jDriver>;
  /** one shared feed engine, since ranking doesn't need per-user state beyond the userId param */
  feed: FeedEngine;
  /** returns the existing GraphMemory for this user, or creates one (sharing the manager's driver) */
  getOrCreate(userId: string, session: MinimalSession): GraphMemory;
  /** true if a GraphMemory has already been created for this user */
  has(userId: string): boolean;
  /** number of users currently managed */
  size(): number;
  /** stops every managed user's background sweep, then closes the shared driver once */
  stopAll(): Promise<void>;
}

export function createGraphMemoryManager(options: GraphMemoryManagerOptions): GraphMemoryManager {
  if (!options.creds && !options.driver) {
    throw new Error("createGraphMemoryManager requires either `creds` or a pre-built `driver`");
  }
  const driverPromise: Promise<Neo4jDriver> = options.driver
    ? Promise.resolve(options.driver)
    : loadNeo4jDriver(options.creds!);

  const feed = createFeedEngine({ driverPromise, metrics: options.metrics });
  const cache = new Map<string, GraphMemory>();

  return {
    driverPromise,
    feed,
    getOrCreate(userId: string, session: MinimalSession): GraphMemory {
      const existing = cache.get(userId);
      if (existing) return existing;

      const mem = enableGraphMemory({
        client: options.client,
        driver: driverPromise, // shared — this is the whole point
        userId,
        session,
        model: options.model,
        intervalMs: options.intervalMs,
        windowSize: options.windowSize,
        metrics: options.metrics,
      }).build();

      cache.set(userId, mem);
      return mem;
    },
    has(userId: string): boolean {
      return cache.has(userId);
    },
    size(): number {
      return cache.size;
    },
    async stopAll(): Promise<void> {
      // Each managed GraphMemory was created with an injected `driver`, so its own
      // stop() won't close it (see graph-memory.ts's ownsDriver flag) — that's what
      // lets us close it exactly once here, after every sweep timer is cleared.
      for (const mem of cache.values()) {
        await mem.stop();
      }
      cache.clear();
      const driver = await driverPromise;
      await driver.close();
    },
  };
}
