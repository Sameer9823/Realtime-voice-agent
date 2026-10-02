import { defineTool } from "../types.js";
import { defineAgent } from "../agent.js";
import { runAgent } from "../run.js";
import { z } from "zod";
import type { GraphMemory, Neo4jDriver } from "./graph-memory.js";
import type { MetricsCollector } from "./metrics.js";

export interface SelfCorrectionOptions {
  memory: GraphMemory;
  model?: string;
  /** relationship count from the user node that triggers a pruning pass, default 200 */
  maxRelationships?: number;
  /** relationship types treated as "too generic", default below */
  genericRelTypes?: string[];
  /** a query is logged as slow if it takes longer than this, default 200ms */
  slowQueryThresholdMs?: number;
  /** optional shared metrics collector, see metrics.ts */
  metrics?: MetricsCollector;
}

export interface SelfCorrectionReport {
  totalRelationships: number;
  duplicateNodeGroups: { label: string; name: string; count: number }[];
  genericRelationshipCounts: { type: string; count: number }[];
  diagnosticsMs: number;
  curatorRan: boolean;
  curatorSummary: string | null;
}

const DEFAULT_GENERIC_TYPES = ["RELATED_TO", "CONNECTED_TO", "LINKED_TO", "ASSOCIATED_WITH"];

/**
 * Runs the three checks named directly in the sketch's "self correction loop" box:
 *   - "Relationships = not good relations"   -> duplicate-node detection
 *   - "Flat relations = too many relations"  -> generic relationship-type + total-count check
 *   - "Query time = too complex"             -> wall-clock timing on the diagnostic queries themselves
 *
 * Diagnostics run as plain Cypher against the driver directly (cheap, deterministic,
 * no LLM call). A curator agent is only invoked — and only given the specific
 * findings, not the whole graph — when there's actually something to fix.
 */
export async function runSelfCorrection(options: SelfCorrectionOptions): Promise<SelfCorrectionReport> {
  const {
    memory,
    model = "claude-sonnet-4-6",
    maxRelationships = 200,
    genericRelTypes = DEFAULT_GENERIC_TYPES,
    slowQueryThresholdMs = 200,
    metrics,
  } = options;

  const { driverPromise, client, userId } = memory;
  const driver: Neo4jDriver = await driverPromise;
  const t0 = Date.now();
  const session = driver.session();

  let totalRelationships = 0;
  let duplicateNodeGroups: SelfCorrectionReport["duplicateNodeGroups"] = [];
  let genericRelationshipCounts: SelfCorrectionReport["genericRelationshipCounts"] = [];

  try {
    // 1. Total relationships hanging off this user's node — cheap, one hop only.
    const countResult = await session.run(
      `MATCH (u:User {id: $userId})-[r]->() RETURN count(r) AS cnt`,
      { userId }
    );
    totalRelationships = toNum(countResult.records[0]?.get("cnt"));

    // 2. Duplicate nodes: same label + same lowercased name, both reachable from this user.
    //    MERGE should prevent this, but case/whitespace drift or a bad write can still create dupes.
    const dupResult = await session.run(
      `MATCH (u:User {id: $userId})-[*1..2]-(n)
       WHERE n.name IS NOT NULL
       WITH labels(n)[0] AS label, toLower(n.name) AS name, collect(DISTINCT n) AS nodes
       WHERE size(nodes) > 1
       RETURN label, name, size(nodes) AS cnt`,
      { userId }
    );
    duplicateNodeGroups = dupResult.records.map((r) => ({
      label: String(r.get("label")),
      name: String(r.get("name")),
      count: toNum(r.get("cnt")),
    }));

    // 3. Generic relationship types — the "flat relations" problem from the sketch.
    const genericResult = await session.run(
      `MATCH (u:User {id: $userId})-[r]->()
       WHERE type(r) IN $genericTypes
       RETURN type(r) AS type, count(r) AS cnt`,
      { userId, genericTypes: genericRelTypes }
    );
    genericRelationshipCounts = genericResult.records.map((r) => ({
      type: String(r.get("type")),
      count: toNum(r.get("cnt")),
    }));
  } finally {
    await session.close();
  }

  const diagnosticsMs = Date.now() - t0;
  if (diagnosticsMs > slowQueryThresholdMs) {
    console.warn(
      `[self-correction] diagnostics took ${diagnosticsMs}ms (threshold ${slowQueryThresholdMs}ms) — ` +
        `consider CREATE INDEX FOR (u:User) ON (u.id) if you haven't already, or reduce the *1..2 hop range.`
    );
  }

  const needsCuration =
    duplicateNodeGroups.length > 0 ||
    genericRelationshipCounts.length > 0 ||
    totalRelationships > maxRelationships;

  if (!needsCuration) {
    const report: SelfCorrectionReport = {
      totalRelationships,
      duplicateNodeGroups,
      genericRelationshipCounts,
      diagnosticsMs,
      curatorRan: false,
      curatorSummary: null,
    };
    metrics?.recordSelfCorrection(report);
    return report;
  }

  // Curator agent gets the tool re-defined locally (bound to the same driver) rather than
  // reusing memory.tool directly, so its description can be curation-specific instead of
  // the write-oriented description the main memory agent uses.
  const curatorTool = defineTool({
    name: "execute_cypher_query",
    description:
      "Run a Cypher query to fix a specific graph problem you were told about. " +
      "Use MATCH + MERGE/DELETE, never a blind rewrite of the whole graph.",
    parameters: z.object({
      query: z.string(),
      params: z.record(z.any()).optional(),
    }),
    execute: async ({ query, params }: { query: string; params?: Record<string, unknown> }) => {
      const s = driver.session();
      try {
        const result = await s.run(query, { userId, ...(params ?? {}) });
        return result.records.map((r) => r.toObject());
      } finally {
        await s.close();
      }
    },
  });

  const curatorAgent = defineAgent({
    name: "graph_curator",
    instructions: [
      "You clean up a specific user's knowledge graph in Neo4j via execute_cypher_query.",
      "You will be given a list of concrete problems found by diagnostics — fix only those,",
      "don't go looking for other things to change.",
      "",
      "For duplicate node groups: MATCH both/all nodes, pick the one with the most relationships",
      "as the canonical node, rewire the others' relationships onto it, then delete the duplicates.",
      "",
      "For generic relationship types (e.g. RELATED_TO): look at what the relationship actually",
      "connects and recreate it with a specific type (LIKES, WORKS_AT, INTERESTED_IN, etc.),",
      "then delete the old generic-typed relationship.",
      "",
      "For 'too many relationships': find the least-recently-relevant or most trivial ones",
      "(one-off mentions, not durable facts) and delete them — keep durable preferences,",
      "relationships, and ongoing projects.",
      "",
      "When done, reply with a short plain-text summary of what you fixed.",
    ].join("\n"),
    model,
    tools: [curatorTool],
  });

  const findingsText = [
    `Total relationships from this user: ${totalRelationships} (threshold: ${maxRelationships})`,
    duplicateNodeGroups.length > 0
      ? `Duplicate node groups:\n${duplicateNodeGroups.map((d) => `- ${d.label} "${d.name}" x${d.count}`).join("\n")}`
      : "No duplicate nodes found.",
    genericRelationshipCounts.length > 0
      ? `Generic relationship types in use:\n${genericRelationshipCounts.map((g) => `- ${g.type} x${g.count}`).join("\n")}`
      : "No generic relationship types found.",
  ].join("\n\n");

  const result = await runAgent(client, curatorAgent, `Diagnostics for user ${userId}:\n\n${findingsText}`);

  const report: SelfCorrectionReport = {
    totalRelationships,
    duplicateNodeGroups,
    genericRelationshipCounts,
    diagnosticsMs,
    curatorRan: true,
    curatorSummary: result.output ?? null,
  };
  metrics?.recordSelfCorrection(report);
  return report;
}

/**
 * Runs runSelfCorrection() on an interval — separate from the memory sweep's own
 * interval, since curation is a maintenance job that should run far less often
 * (default 15 min vs. the memory sweep's 3 min).
 */
export function startSelfCorrectionLoop(
  options: SelfCorrectionOptions & { intervalMs?: number }
): { stop(): void } {
  const { intervalMs = 15 * 60_000, ...rest } = options;

  const run = () => {
    runSelfCorrection(rest)
      .then((report) => {
        if (report.curatorRan) {
          console.log("[self-correction]", report.curatorSummary);
        }
      })
      .catch((err) => console.error("[self-correction] pass failed:", err));
  };

  run();
  const timer = setInterval(run, intervalMs);
  return { stop: () => clearInterval(timer) };
}

function toNum(v: unknown): number {
  if (v && typeof v === "object" && "toNumber" in (v as any)) return (v as any).toNumber();
  return typeof v === "number" ? v : Number(v ?? 0);
}
