import { defineTool } from "../types.js";
import { z } from "zod";
import type { Neo4jDriver } from "./graph-memory.js";
import type { MetricsCollector } from "./metrics.js";

/**
 * Why this exists: execute_cypher_query (graph-memory.ts) lets the memory agent
 * write arbitrary Cypher, which is flexible but gives no guarantee any two writes
 * timestamp things the same way, or that a new fact ever supersedes an old
 * contradicting one — "loves hiking" written in March and "doesn't hike anymore"
 * written in August just become two permanent edges with nothing connecting them.
 *
 * upsert_fact is a second, narrower tool for the common case (store one
 * subject-relation-object fact about the user) that GUARANTEES timestamping and
 * can explicitly retire old relationship types on write. The memory agent is
 * instructed to prefer this for ordinary facts and fall back to
 * execute_cypher_query only for things this shape can't express.
 *
 * Cypher can't parametrize relationship types or labels (they're not values),
 * so both are validated against a strict allowlist pattern before being
 * interpolated into the query string — this is the injection-safety boundary.
 */

const RELATION_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const LABEL_PATTERN = /^[A-Z][A-Za-z0-9]{0,63}$/;

function assertSafeRelation(value: string, kind: string): void {
  if (!RELATION_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${kind} "${value}": must be UPPER_SNAKE_CASE, start with a letter, max 64 chars (e.g. LIKES, INTERESTED_IN)`
    );
  }
}

function assertSafeLabel(value: string, kind: string): void {
  if (!LABEL_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${kind} "${value}": must be TitleCase, start with a letter, alphanumeric only, max 64 chars (e.g. Topic, Person, Project)`
    );
  }
}

export interface UpsertFactParams {
  relation: string;
  objectLabel: string;
  objectName: string;
  /** relationship types to remove from user->this-same-object before writing the new one */
  contradicts?: string[];
}

export function createUpsertFactTool(driverPromise: Promise<Neo4jDriver>, userId: string) {
  return defineTool({
    name: "upsert_fact",
    description: [
      "Store ONE fact about the user as user -[relation]-> object. Prefer this over",
      "execute_cypher_query for ordinary facts (preferences, relationships, projects) —",
      "it timestamps the fact automatically, which execute_cypher_query does not guarantee.",
      "",
      "relation: UPPER_SNAKE_CASE, e.g. LIKES, WORKS_AT, INTERESTED_IN, DISLIKES.",
      "objectLabel: TitleCase node label for the object, e.g. Topic, Person, Project, Place.",
      "objectName: the object's name, e.g. 'hiking'.",
      "contradicts: relation types to retire on this same object first, e.g. writing",
      "  DISLIKES hiking with contradicts:['LIKES'] removes the old LIKES->hiking edge",
      "  instead of leaving both to coexist forever.",
    ].join("\n"),
    parameters: z.object({
      relation: z.string(),
      objectLabel: z.string(),
      objectName: z.string(),
      contradicts: z.array(z.string()).optional(),
    }),
    execute: async ({ relation, objectLabel, objectName, contradicts }: UpsertFactParams) => {
      assertSafeRelation(relation, "relation");
      assertSafeLabel(objectLabel, "objectLabel");
      for (const c of contradicts ?? []) assertSafeRelation(c, "contradicts relation");

      const driver = await driverPromise;
      const s = driver.session();
      try {
        let retired = 0;
        for (const oldRelation of contradicts ?? []) {
          const result = await s.run(
            `MATCH (u:User {id: $userId})-[r:${oldRelation}]->(o:${objectLabel} {name: $objectName})
             DELETE r
             RETURN count(r) AS deleted`,
            { userId, objectName }
          );
          retired += toNum(result.records[0]?.get("deleted"));
        }

        await s.run(
          `MERGE (u:User {id: $userId})
           MERGE (o:${objectLabel} {name: $objectName})
           MERGE (u)-[rel:${relation}]->(o)
           SET rel.updatedAt = timestamp(),
               rel.createdAt = coalesce(rel.createdAt, timestamp())`,
          { userId, objectName }
        );

        return { stored: `${relation} -> ${objectLabel}(${objectName})`, retiredFacts: retired };
      } finally {
        await s.close();
      }
    },
  });
}

export interface RecencyDecayOptions {
  driverPromise: Promise<Neo4jDriver>;
  userId: string;
  /** days for a fact's weight to halve, default 30 */
  halfLifeDays?: number;
  /** facts decayed below this weight are deleted outright, default 0.05 (~5x half-life old) */
  pruneThreshold?: number;
  /** optional shared metrics collector, see metrics.ts */
  metrics?: MetricsCollector;
}

export interface RecencyDecayReport {
  scored: number;
  pruned: number;
}

/**
 * Computes an exponential-decay weight for every timestamped fact (written via
 * upsert_fact) based on age, stores it as r.weight (so feed-engine.ts or a
 * future ranking pass can use it), and deletes facts that have decayed past
 * the prune threshold outright — old one-off mentions fade out instead of
 * accumulating forever.
 *
 * Facts without r.updatedAt (written via raw execute_cypher_query, or
 * predating this feature) are left untouched — decay only applies to facts
 * that opted in by being written through upsert_fact.
 */
export async function applyRecencyDecay(options: RecencyDecayOptions): Promise<RecencyDecayReport> {
  const { driverPromise, userId, halfLifeDays = 30, pruneThreshold = 0.05, metrics } = options;
  const driver = await driverPromise;
  const session = driver.session();

  try {
    const readResult = await session.run(
      `MATCH (u:User {id: $userId})-[r]->(n)
       WHERE r.updatedAt IS NOT NULL
       RETURN elementId(r) AS relId, r.updatedAt AS updatedAt`,
      { userId }
    );

    const now = Date.now();
    const toPrune: string[] = [];
    const toReweight: { relId: string; weight: number }[] = [];

    for (const record of readResult.records) {
      const relId = record.get("relId") as string;
      const updatedAt = toNum(record.get("updatedAt"));
      const ageDays = (now - updatedAt) / 86_400_000;
      const weight = Math.pow(0.5, ageDays / halfLifeDays);

      if (weight < pruneThreshold) {
        toPrune.push(relId);
      } else {
        toReweight.push({ relId, weight });
      }
    }

    if (toReweight.length > 0) {
      await session.run(
        `UNWIND $items AS item
         MATCH ()-[r]->() WHERE elementId(r) = item.relId
         SET r.weight = item.weight`,
        { items: toReweight }
      );
    }

    if (toPrune.length > 0) {
      await session.run(
        `MATCH ()-[r]->() WHERE elementId(r) IN $ids
         DELETE r`,
        { ids: toPrune }
      );
    }

    const report: RecencyDecayReport = { scored: toReweight.length, pruned: toPrune.length };
    metrics?.recordDecay(report);
    return report;
  } finally {
    await session.close();
  }
}

function toNum(v: unknown): number {
  if (v && typeof v === "object" && "toNumber" in (v as any)) return (v as any).toNumber();
  return typeof v === "number" ? v : Number(v ?? 0);
}
