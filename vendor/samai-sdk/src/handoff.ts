import { z } from "zod";
import type { Agent } from "./agent.js";
import type { ToolDefinition } from "./types.js";

const HANDOFF_PREFIX = "handoff_to__";

export function handoffToolName(agentName: string): string {
  return `${HANDOFF_PREFIX}${agentName.replace(/\s+/g, "_").toLowerCase()}`;
}

export function isHandoffTool(toolName: string): boolean {
  return toolName.startsWith(HANDOFF_PREFIX);
}

/**
 * Builds one synthetic tool per allowed handoff target so the model can
 * "call" a handoff exactly like any other tool. The run loop intercepts
 * calls to these before normal tool execution — `execute` here is never
 * actually invoked, it only exists so the tool satisfies ToolDefinition's
 * shape if something calls it directly (e.g. a unit test).
 */
export function buildHandoffTools(handoffs: Agent<any>[] = []): ToolDefinition[] {
  return handoffs.map((target) => ({
    name: handoffToolName(target.name),
    description:
      `Transfer this conversation to the "${target.name}" agent when their expertise better fits the ` +
      `user's request. What "${target.name}" handles: ${target.instructions.slice(0, 200)}`,
    parameters: z.object({ reason: z.string().describe("Brief reason for handing off") }),
    execute: async (args: { reason: string }) => args,
  }));
}

/** Thrown when a handoff would revisit an agent already seen in this run, or exceed the run's maxHandoffs cap — prevents A→B→A infinite delegation loops. */
export class HandoffLoopError extends Error {
  constructor(public agentPath: string[], public attemptedTarget: string) {
    super(
      `Handoff loop or limit exceeded: cannot hand off to "${attemptedTarget}" ` +
        `(agent path so far: ${agentPath.join(" -> ")}).`
    );
    this.name = "HandoffLoopError";
  }
}
