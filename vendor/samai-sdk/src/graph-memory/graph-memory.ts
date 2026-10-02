import { defineTool, type ToolDefinition } from "../types.js";
import { defineAgent } from "../agent.js";
import { runAgent } from "../run.js";
import { z } from "zod";
import { createUpsertFactTool } from "./fact-lifecycle.js";
import type { MetricsCollector } from "./metrics.js";

/**
 * Minimal Neo4j Driver/Session shape this module needs — kept local instead of
 * importing neo4j-driver's types directly, since neo4j-driver is an optional
 * peer dependency (see loadNeo4jDriver() below), same pattern as
 * session-stores/redis.ts uses for ioredis.
 */
export interface Neo4jSession {
  run(query: string, params?: Record<string, unknown>): Promise<{ records: Neo4jRecord[] }>;
  close(): Promise<void>;
}
export interface Neo4jRecord {
  get(key: string): unknown;
  toObject(): Record<string, unknown>;
}
export interface Neo4jDriver {
  session(): Neo4jSession;
  close(): Promise<void>;
}

/**
 * Requires the optional `neo4j-driver` peer dependency (`npm install neo4j-driver`);
 * imported dynamically so the rest of the SDK works fine without it installed —
 * same pattern RedisSessionStore uses for ioredis.
 */
export async function loadNeo4jDriver(creds: Neo4jCreds): Promise<Neo4jDriver> {
  let neo4j: {
    driver: (uri: string, auth: unknown) => Neo4jDriver;
    auth: { basic: (u: string, p: string) => unknown };
  };
  try {
    ({ default: neo4j } = await import("neo4j-driver"));
  } catch (err) {
    throw new Error(
      "enableGraphMemory requires the optional `neo4j-driver` package. Install it with `npm install neo4j-driver`.",
      { cause: err }
    );
  }
  return neo4j.driver(creds.uri, neo4j.auth.basic(creds.username, creds.password));
}

/**
 * Minimal shape we need out of an samai-sdk Session — matches
 * SessionStore.getMessages() (see samai-sdk docs: "Sessions (memory)").
 * We depend on this shape rather than importing samai-sdk's Session type
 * directly, so this plugin keeps working even if that type moves.
 */
export interface MinimalMessage {
  role: string;
  content: unknown;
}

export interface MinimalSession {
  getMessages(): Promise<MinimalMessage[]> | MinimalMessage[];
}

export interface Neo4jCreds {
  uri: string;
  username: string;
  password: string;
}

export interface GraphMemoryOptions {
  /** an samai-sdk client, e.g. createClient({ provider: anthropic({...}) }) */
  client: any;
  /**
   * Provide EITHER creds (we dynamically import neo4j-driver and own the
   * resulting driver, closing it on stop()) OR an already-constructed driver
   * / driver promise (you own its lifecycle — useful for sharing one driver
   * across multiple users via createGraphMemoryManager, or injecting a fake
   * in tests without needing neo4j-driver installed at all).
   */
  creds?: Neo4jCreds;
  driver?: Neo4jDriver | Promise<Neo4jDriver>;
  /** model used by the private memory agent, default matches the SDK's docs examples */
  model?: string;
  /** how often the background sweep runs, default 3 minutes */
  intervalMs?: number;
  /** identifies whose graph this is, used as the anchor node in every query */
  userId: string;
  /** where to read recent conversation from for each sweep */
  session: MinimalSession;
  /** how many recent messages to look at per sweep, default 20 */
  windowSize?: number;
  /** optional shared metrics collector, see metrics.ts */
  metrics?: MetricsCollector;
}

export interface GraphMemory {
  /** the execute_cypher_query tool — pass this to your PRIVATE memory agent only, not the main chat agent */
  tool: ToolDefinition<any, any>;
  /**
   * Resolves to the underlying Neo4j driver. A promise (not a plain Driver)
   * because neo4j-driver is dynamically imported (see loadNeo4jDriver) — it
   * resolves once and every internal caller reuses the same promise, so
   * awaiting it after the first call is effectively instant.
   */
  driverPromise: Promise<Neo4jDriver>;
  /** samai-sdk client, exposed so self-correction.ts can run its own curator agent without a second connection */
  client: any;
  userId: string;
  /** current running-context string, safe to read any time */
  getRunningContext(): string;
  /** run one sweep immediately and return the updated running context */
  sweepOnce(): Promise<string>;
  /** start the interval-based background sweep */
  start(): void;
  /** stop the background sweep and close the Neo4j driver */
  stop(): Promise<void>;
}

/**
 * enableGraphMemory({ client, creds, userId, session }).build()
 *
 * Wires a per-user Neo4j graph as long-term memory for an samai-sdk agent:
 *  - a private memory agent autonomously writes Cypher against the graph
 *  - a background interval periodically sweeps recent conversation into the graph
 *  - the sweep's output becomes "running context" you inject into your main
 *    agent's system prompt on each turn (see with-running-context.ts)
 */
export function enableGraphMemory(options: GraphMemoryOptions): { build(): GraphMemory } {
  const {
    client,
    creds,
    userId,
    session,
    model = "claude-sonnet-4-6",
    intervalMs = 3 * 60_000,
    windowSize = 20,
    metrics,
  } = options;

  if (!options.creds && !options.driver) {
    throw new Error("enableGraphMemory requires either `creds` or a pre-built `driver`");
  }
  const ownsDriver = !options.driver;
  const driverPromise: Promise<Neo4jDriver> = options.driver
    ? Promise.resolve(options.driver)
    : loadNeo4jDriver(creds!);

  const executeCypherQuery = defineTool({
    name: "execute_cypher_query",
    description: [
      "Run a Cypher query against this user's personal knowledge graph in Neo4j.",
      "Rules you must follow:",
      "- Always MERGE, never blind CREATE — check whether a node already exists first.",
      "- Anchor every query on this user's node: MERGE (u:User {id: $userId}).",
      "- Prefer specific relationship types (LIKES, WORKS_AT, INTERESTED_IN) over one generic RELATED_TO.",
      "- Skip trivial or one-off facts; only store things worth remembering next conversation.",
    ].join("\n"),
    parameters: z.object({
      query: z.string().describe("A Cypher query, using $userId and any other named parameters"),
      params: z.record(z.any()).optional().describe("Query parameters, e.g. { userId, topic: 'hiking' }"),
    }),
    execute: async ({ query, params }: { query: string; params?: Record<string, unknown> }) => {
      const driver = await driverPromise;
      const s = driver.session();
      try {
        const result = await s.run(query, { userId, ...(params ?? {}) });
        return result.records.map((r) => r.toObject());
      } finally {
        await s.close();
      }
    },
  });

  const upsertFact = createUpsertFactTool(driverPromise, userId);

  const memoryAgent = defineAgent({
    name: "private_memory_agent",
    instructions: [
      "You maintain a per-user knowledge graph in Neo4j via two tools:",
      "- upsert_fact: use this for ordinary facts (preferences, relationships, projects).",
      "  It timestamps automatically and can retire a contradicting old fact via `contradicts`",
      "  (e.g. user now dislikes something they used to like: relation DISLIKES, contradicts: ['LIKES']).",
      "- execute_cypher_query: only for things upsert_fact can't express (multi-hop queries,",
      "  bulk operations). Prefer upsert_fact whenever the fact is a simple subject-relation-object.",
      "",
      "You'll be given a slice of recent conversation. Decide what durable facts about the",
      "user are worth storing (preferences, relationships, ongoing projects, recurring topics)",
      "and write them to the graph. First check if a matching node already exists before creating one.",
      "",
      "After updating the graph, your final answer must be a short (3-5 line) plain-text summary",
      "of what you now know about this user — that summary becomes another agent's context,",
      "not a report of the steps you took.",
    ].join("\n"),
    model,
    tools: [upsertFact, executeCypherQuery],
  });

  let runningContext = "";
  let timer: ReturnType<typeof setInterval> | null = null;

  async function sweepOnce(): Promise<string> {
    const messages = await session.getMessages();
    const recent = messages.slice(-windowSize);
    if (recent.length === 0) return runningContext;

    const transcript = recent
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n");

    const t0 = Date.now();
    try {
      const result = await runAgent(
        client,
        memoryAgent,
        `Recent conversation with user ${userId}:\n${transcript}\n\nUpdate the graph, then summarize what you know about this user.`
      );
      if (result.output) runningContext = result.output;
      metrics?.recordSweep(true, Date.now() - t0);
      return runningContext;
    } catch (err) {
      metrics?.recordSweep(false, Date.now() - t0);
      throw err;
    }
  }

  return {
    build(): GraphMemory {
      return {
        tool: executeCypherQuery,
        driverPromise,
        client,
        userId,
        getRunningContext: () => runningContext,
        sweepOnce,
        start() {
          if (timer) return;
          sweepOnce().catch((err) => console.error("[graph-memory] sweep failed:", err));
          timer = setInterval(() => {
            sweepOnce().catch((err) => console.error("[graph-memory] sweep failed:", err));
          }, intervalMs);
        },
        async stop() {
          if (timer) clearInterval(timer);
          timer = null;
          if (ownsDriver) {
            const driver = await driverPromise;
            await driver.close();
          }
        },
      };
    },
  };
}
