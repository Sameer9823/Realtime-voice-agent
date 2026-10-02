import type { InputGuardrail, OutputGuardrail, ToolDefinition, ToolGuardrail } from "./types.js";
import type { AnySchema } from "./schema-adapter.js";

export interface AgentGuardrails {
  input?: InputGuardrail[];
  output?: OutputGuardrail[];
  /** Run before each tool call executes; use to block dangerous calls (e.g. by tool name or argument content) before they run. */
  tool?: ToolGuardrail[];
}

export interface AgentConfig<TOutput = string> {
  /** Unique, human-readable name. Used in traces/logs and as the handoff target identifier — must be unique across any set of agents that hand off to each other. */
  name: string;
  /** System instructions for this agent. */
  instructions: string;
  /** Model identifier, passed straight through to the provider (e.g. "claude-sonnet-4-6", "gpt-4o"). */
  model: string;
  /** Tools this agent can call. */
  tools?: ToolDefinition[];
  /** Other agents this agent is allowed to hand off to. */
  handoffs?: Agent<any>[];
  /** If set, the agent's final answer is parsed and validated against this schema instead of returned as raw text. A zod schema, or any Standard Schema V1 validator (e.g. valibot 0.31+). */
  outputSchema?: AnySchema<TOutput>;
  /** Agent-scoped guardrails, run in addition to any client-level guardrails. */
  guardrails?: AgentGuardrails;
  /** Safe stopping condition — max consecutive turns this agent can take before the run aborts with MaxTurnsExceededError. Default: 10. */
  maxTurns?: number;
}

export interface Agent<TOutput = string> extends AgentConfig<TOutput> {
  maxTurns: number;
}

/**
 * Defines a reusable agent: instructions + model + tools + (optionally) handoffs,
 * guardrails, and a structured output schema, bundled as one named unit.
 *
 * An Agent is pure configuration — it holds no run state. Pass it to `runAgent()`
 * or `runAgentStream()` along with a `Client` and user input to actually execute it.
 */
export function defineAgent<TOutput = string>(config: AgentConfig<TOutput>): Agent<TOutput> {
  if (!config.name.trim()) throw new Error("defineAgent() requires a non-empty `name`");
  if (!config.instructions.trim()) throw new Error("defineAgent() requires non-empty `instructions`");
  return { maxTurns: 10, ...config };
}
