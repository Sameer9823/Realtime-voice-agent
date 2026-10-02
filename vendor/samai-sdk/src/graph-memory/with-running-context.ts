import { runAgent } from "../run.js";
import type { GraphMemory } from "./graph-memory.js";

/**
 * Calls your main chat agent with the graph memory's current running context
 * prepended to the user's message. This is the "feedback loop" from the
 * diagram: background sweep -> running context -> next reply.
 */
export async function chatWithMemory(
  client: any,
  agent: any,
  memory: GraphMemory,
  input: string,
  runOptions?: Record<string, unknown>
) {
  const context = memory.getRunningContext();
  const contextualInput = context
    ? `[What we know about this user so far]\n${context}\n\n[User message]\n${input}`
    : input;

  return runAgent(client, agent, contextualInput, runOptions as any);
}
