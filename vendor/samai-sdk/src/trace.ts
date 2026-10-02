import type { Usage } from "./types.js";

export type TraceEvent =
  | { type: "run-started"; agentName: string; timestamp: number }
  | { type: "model-call"; agentName: string; model: string; turn: number; timestamp: number }
  | { type: "model-call-completed"; agentName: string; usage: Usage; timestamp: number }
  | { type: "tool-call"; agentName: string; toolName: string; args: unknown; timestamp: number }
  | { type: "tool-result"; agentName: string; toolName: string; isError: boolean; timestamp: number }
  | { type: "handoff"; fromAgent: string; toAgent: string; reason?: string; timestamp: number }
  | { type: "retry"; agentName: string; attempt: number; delayMs: number; error: string; timestamp: number }
  | { type: "fallback"; agentName: string; failedProvider: string; nextProvider: string; error: string; timestamp: number }
  | { type: "timeout"; agentName: string; model: string; timeoutMs: number; timestamp: number }
  | { type: "guardrail-triggered"; stage: "input" | "output" | "tool"; agentName: string; reason: string; timestamp: number }
  | { type: "approval-requested"; agentName: string; toolName: string; timestamp: number }
  | { type: "approval-resolved"; agentName: string; toolName: string; approved: boolean; timestamp: number }
  | { type: "run-completed"; timestamp: number }
  | { type: "voice-turn"; agentName: string; transcript: string; timestamp: number }
  | { type: "interruption"; agentName: string; reason: string; timestamp: number }
  | { type: "clarification"; agentName: string; question: string; timestamp: number }
  | { type: "goal-update"; agentName: string; goal: string; status: string; timestamp: number }
  | { type: "run-failed"; error: string; timestamp: number };

export interface RunTrace {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  /** Names of agents visited, in order — the handoff path for this run. */
  agentPath: string[];
  events: TraceEvent[];
  /** Token usage summed across every model call in the run, including ones before a handoff. */
  totalUsage: Usage;
}

export function createTrace(runId: string, startAgentName: string): RunTrace {
  return {
    runId,
    startedAt: Date.now(),
    agentPath: [startAgentName],
    events: [{ type: "run-started", agentName: startAgentName, timestamp: Date.now() }],
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

/** Omit that distributes over a union instead of collapsing it to shared keys. */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

export function recordEvent(trace: RunTrace, event: DistributiveOmit<TraceEvent, "timestamp">): TraceEvent {
  const full = { ...event, timestamp: Date.now() } as TraceEvent;
  trace.events.push(full);
  return full;
}

export function addUsage(trace: RunTrace, usage: Usage): void {
  trace.totalUsage = {
    inputTokens: trace.totalUsage.inputTokens + usage.inputTokens,
    outputTokens: trace.totalUsage.outputTokens + usage.outputTokens,
    totalTokens: trace.totalUsage.totalTokens + usage.totalTokens,
  };
}

export function finishTrace(trace: RunTrace): void {
  trace.finishedAt = Date.now();
}

/** Total wall-clock duration of the run in milliseconds, or elapsed-so-far if still running. */
export function traceDurationMs(trace: RunTrace): number {
  return (trace.finishedAt ?? Date.now()) - trace.startedAt;
}
