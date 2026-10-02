import type { Message } from "./types.js";
import type { RunTrace } from "./trace.js";

/**
 * A snapshot of an in-progress `runAgent()` call, captured after each completed turn
 * (model call + any tool execution/handoff), sufficient to resume the run from that point
 * rather than restarting it from the original input.
 *
 * Agent *definitions* (instructions, tools, code) are not part of this — you still pass the
 * same root agent to `resumeAgentStream()` that you started the run with. What's checkpointed
 * is the run's accumulated *state*: which agent is currently active, the message history so
 * far, and the loop/handoff counters needed to keep safety limits (`maxTurns`, `maxHandoffs`)
 * correct across the resume.
 */
export interface RunCheckpoint {
  runId: string;
  /** Name of the agent that was active when this checkpoint was taken. */
  agentName: string;
  messages: Message[];
  /** Index into `messages` marking where this run's new messages start (vs. ones loaded from a Session). */
  newMessagesStart: number;
  turnsForCurrentAgent: number;
  totalTurns: number;
  handoffCount: number;
  visitedAgents: string[];
  trace: RunTrace;
  savedAt: number;
}

/**
 * Storage adapter for run checkpoints — same shape family as `SessionStore` and
 * `VectorStore` (a handful of methods, swap implementations without touching call sites).
 */
export interface RunCheckpointStore {
  save(checkpoint: RunCheckpoint): Promise<void> | void;
  load(runId: string): Promise<RunCheckpoint | null> | RunCheckpoint | null;
  delete(runId: string): Promise<void> | void;
}

/** Default store — lives only for the process lifetime. Only useful for resuming after a caught error within the same process, not a real crash/restart. */
export class InMemoryCheckpointStore implements RunCheckpointStore {
  private checkpoints = new Map<string, RunCheckpoint>();

  save(checkpoint: RunCheckpoint): void {
    this.checkpoints.set(checkpoint.runId, checkpoint);
  }
  load(runId: string): RunCheckpoint | null {
    return this.checkpoints.get(runId) ?? null;
  }
  delete(runId: string): void {
    this.checkpoints.delete(runId);
  }
}

/** Persists each checkpoint as a JSON file on disk — survives process restarts/crashes with zero extra infra. */
export class FileCheckpointStore implements RunCheckpointStore {
  constructor(private dir: string) {}

  private async pathFor(runId: string): Promise<string> {
    const { join } = await import("node:path");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.dir, { recursive: true });
    return join(this.dir, `${encodeURIComponent(runId)}.json`);
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(await this.pathFor(checkpoint.runId), JSON.stringify(checkpoint, null, 2), "utf-8");
  }

  async load(runId: string): Promise<RunCheckpoint | null> {
    const { readFile } = await import("node:fs/promises");
    try {
      const raw = await readFile(await this.pathFor(runId), "utf-8");
      return JSON.parse(raw) as RunCheckpoint;
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(runId: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(await this.pathFor(runId), { force: true });
  }
}

/** Depth-first search through an agent's `handoffs` tree for one named `name`, including the root itself. */
export function findAgentByName(
  root: import("./agent.js").Agent<any>,
  name: string
): import("./agent.js").Agent<any> | undefined {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const agent = stack.pop()!;
    if (seen.has(agent.name)) continue;
    seen.add(agent.name);
    if (agent.name === name) return agent;
    for (const next of agent.handoffs ?? []) stack.push(next);
  }
  return undefined;
}
