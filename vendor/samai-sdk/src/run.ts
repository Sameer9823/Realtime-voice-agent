import { randomUUID } from "node:crypto";
import type { Agent } from "./agent.js";
import { GuardrailBlockedError, type Client } from "./client.js";
import { buildHandoffTools, handoffToolName, isHandoffTool, HandoffLoopError } from "./handoff.js";
import { parseJsonAgainstSchema } from "./json-utils.js";
import { InMemorySessionStore, createSession, type Session } from "./session.js";
import { addUsage, createTrace, finishTrace, recordEvent, type RunTrace } from "./trace.js";
import { executeToolCalls } from "./tool-loop.js";
import type { GenerateResult, Message, ToolCallPart, Usage } from "./types.js";
import { findAgentByName, type RunCheckpoint, type RunCheckpointStore } from "./checkpoint.js";

export type AgentEvent =
  | { type: "run-started"; runId: string; agentName: string }
  | { type: "run-resumed"; runId: string; agentName: string }
  | { type: "text-delta"; textDelta: string; agentName: string }
  | { type: "tool-started"; toolName: string; args: unknown }
  | { type: "tool-completed"; toolName: string; result: unknown; isError: boolean }
  | { type: "handoff-started"; fromAgent: string; toAgent: string; reason?: string }
  | { type: "retry-attempted"; agentName: string; attempt: number; delayMs: number; error: string }
  | { type: "fallback-triggered"; agentName: string; failedProvider: string; nextProvider: string; error: string }
  | { type: "timeout-occurred"; agentName: string; model: string; timeoutMs: number }
  | { type: "guardrail-triggered"; stage: "input" | "output" | "tool"; agentName: string; reason: string }
  | { type: "approval-requested"; toolName: string; args: unknown }
  | { type: "approval-resolved"; toolName: string; approved: boolean }
  | { type: "run-completed"; output: unknown; text: string; usage: Usage }
  | { type: "run-failed"; error: string };

export interface RunAgentOptions {
  /** Persists conversation history across separate runAgent() calls. Defaults to a fresh in-memory session scoped to this one run. */
  session?: Session;
  /** Total handoffs allowed across the whole run, regardless of which agents are involved. Default: 5. */
  maxHandoffs?: number;
  signal?: AbortSignal;
  /** Default timeout for tool `execute()` calls, in ms, for tools that don't set their own. Default: 30000. */
  defaultToolTimeoutMs?: number;
  /**
   * Invoked when a tool marked `requiresApproval` is about to run. Return (or
   * resolve to) `true` to allow it. If omitted, approval-gated tools are
   * rejected by default — the run fails closed rather than executing a risky
   * action unattended. This is where you'd surface a confirmation prompt to a
   * human, e.g. via a UI dialog or a Slack approval message.
   */
  onApprovalRequest?: (info: { agentName: string; toolName: string; args: unknown }) => boolean | Promise<boolean>;
  /**
   * Persists a `RunCheckpoint` after every completed turn (model call + any tool execution or
   * handoff), so the run can be resumed with `resumeAgentStream()`/`resumeAgent()` after a
   * crash or process restart instead of starting over from the original input. `runId`
   * defaults to a fresh random id if not given — pass one explicitly if you need to know it
   * ahead of time (e.g. to resume a specific run later). The checkpoint is deleted
   * automatically when the run finishes successfully; it's left in place on failure so you
   * can inspect it or resume past the failure point.
   */
  checkpoint?: { store: RunCheckpointStore; runId?: string };
}

export interface RunResult<TOutput = string> {
  runId: string;
  output: TOutput;
  text: string;
  /** Name of whichever agent produced the final answer — may differ from the starting agent if handoffs occurred. */
  finalAgent: string;
  messages: Message[];
  trace: RunTrace;
}

export class MaxTurnsExceededError extends Error {
  constructor(public agentName: string, public maxTurns: number) {
    super(`Agent "${agentName}" exceeded its maxTurns limit (${maxTurns}) without producing a final answer.`);
    this.name = "MaxTurnsExceededError";
  }
}

/** Wraps any error thrown mid-run, attaching the trace collected up to the point of failure so callers can still inspect what happened. */
export class AgentRunError extends Error {
  constructor(public cause: unknown, public trace: RunTrace) {
    super(`Agent run failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AgentRunError";
  }
}

/** Thrown by `resumeAgentStream()`/`resumeAgent()` when there's no checkpoint to resume, or it references an agent unreachable from the one passed in. */
export class CheckpointNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointNotFoundError";
  }
}

const ABSOLUTE_TURN_CAP = 50; // hard safety net regardless of any single agent's maxTurns

/** Mutable in-progress state for one run — built fresh by `runAgentStream()`, or restored from a `RunCheckpoint` by `resumeAgentStream()`. */
interface RunLoopState {
  runId: string;
  trace: RunTrace;
  messages: Message[];
  currentAgent: Agent<any>;
  turnsForCurrentAgent: number;
  totalTurns: number;
  handoffCount: number;
  visitedAgents: Set<string>;
  newMessagesStart: number;
}

/**
 * The actual agent loop, shared by both `runAgentStream()` (fresh runs) and
 * `resumeAgentStream()` (resumed runs) — everything from "how a turn works" to
 * "when to checkpoint" lives here exactly once, so a resumed run behaves
 * identically to a fresh one from this point forward.
 */
async function* runLoop<TOutput>(
  client: Client,
  session: Session,
  options: RunAgentOptions,
  state: RunLoopState
): AsyncGenerator<AgentEvent, RunResult<TOutput>, void> {
  const maxHandoffs = options.maxHandoffs ?? 5;
  const { runId, trace, visitedAgents, newMessagesStart } = state;
  let messages = state.messages;
  let currentAgent = state.currentAgent;
  let turnsForCurrentAgent = state.turnsForCurrentAgent;
  let totalTurns = state.totalTurns;
  let handoffCount = state.handoffCount;

  const checkpointConfig = options.checkpoint;
  async function saveCheckpoint(): Promise<void> {
    if (!checkpointConfig) return;
    const checkpoint: RunCheckpoint = {
      runId,
      agentName: currentAgent.name,
      messages,
      newMessagesStart,
      turnsForCurrentAgent,
      totalTurns,
      handoffCount,
      visitedAgents: [...visitedAgents],
      trace,
      savedAt: Date.now(),
    };
    await checkpointConfig.store.save(checkpoint);
  }

  try {
    while (true) {
      totalTurns++;
      turnsForCurrentAgent++;
      if (totalTurns > ABSOLUTE_TURN_CAP) throw new MaxTurnsExceededError(currentAgent.name, ABSOLUTE_TURN_CAP);
      if (turnsForCurrentAgent > currentAgent.maxTurns) {
        throw new MaxTurnsExceededError(currentAgent.name, currentAgent.maxTurns);
      }

      // --- agent-scoped input guardrails ---
      for (const guardrail of currentAgent.guardrails?.input ?? []) {
        const result = await guardrail({ messages });
        if (!result.allowed) {
          const reason = result.reason ?? "unspecified";
          recordEvent(trace, { type: "guardrail-triggered", stage: "input", agentName: currentAgent.name, reason });
          yield { type: "guardrail-triggered", stage: "input", agentName: currentAgent.name, reason };
          throw new GuardrailBlockedError(reason, "input");
        }
        if (result.modifiedMessages) messages = result.modifiedMessages;
      }

      const tools = [...(currentAgent.tools ?? []), ...buildHandoffTools(currentAgent.handoffs)];

      recordEvent(trace, { type: "model-call", agentName: currentAgent.name, model: currentAgent.model, turn: totalTurns });

      let text = "";
      const toolCalls: ToolCallPart[] = [];
      let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      // Resilience wrappers (withRetry/withFallback/withTimeout, if the provider passed to
      // createClient() was built with createResilientProvider()) fire these hooks from inside
      // their own retry loop, which runs before any chunk is yielded to us — a generator can
      // only `yield` from its own body, not from inside a nested callback, so we record to the
      // trace synchronously (safe/ordered) and queue the AgentEvent, then drain the queue right
      // after the model call finishes. See the identical pattern for approval events below.
      const resilienceEvents: AgentEvent[] = [];

      for await (const chunk of client.stream({
        model: currentAgent.model,
        system: currentAgent.instructions,
        messages,
        tools,
        maxToolRoundtrips: 1,
        signal: options.signal,
        onRetry: (info) => {
          const error = info.error instanceof Error ? info.error.message : String(info.error);
          recordEvent(trace, { type: "retry", agentName: currentAgent.name, attempt: info.attempt, delayMs: info.delayMs, error });
          resilienceEvents.push({ type: "retry-attempted", agentName: currentAgent.name, attempt: info.attempt, delayMs: info.delayMs, error });
        },
        onFallback: (info) => {
          const error = info.error instanceof Error ? info.error.message : String(info.error);
          recordEvent(trace, { type: "fallback", agentName: currentAgent.name, failedProvider: info.failedProvider, nextProvider: info.nextProvider, error });
          resilienceEvents.push({ type: "fallback-triggered", agentName: currentAgent.name, failedProvider: info.failedProvider, nextProvider: info.nextProvider, error });
        },
        onTimeout: (info) => {
          recordEvent(trace, { type: "timeout", agentName: currentAgent.name, model: info.model, timeoutMs: info.timeoutMs });
          resilienceEvents.push({ type: "timeout-occurred", agentName: currentAgent.name, model: info.model, timeoutMs: info.timeoutMs });
        },
      })) {
        if (chunk.type === "text-delta") {
          text += chunk.textDelta;
          yield { type: "text-delta", textDelta: chunk.textDelta, agentName: currentAgent.name };
        } else if (chunk.type === "tool-call") {
          toolCalls.push(chunk.toolCall);
        } else if (chunk.type === "finish") {
          usage = chunk.usage;
        } else if (chunk.type === "error") {
          throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
        }
      }

      for (const event of resilienceEvents) yield event;

      addUsage(trace, usage);
      recordEvent(trace, { type: "model-call-completed", agentName: currentAgent.name, usage });

      messages = [
        ...messages,
        { role: "assistant", content: toolCalls.length > 0 ? [{ type: "text", text }, ...toolCalls] : text },
      ];

      // --- handoff interception (checked before normal tool execution) ---
      const handoffCall = toolCalls.find((tc) => isHandoffTool(tc.toolName));
      if (handoffCall) {
        const target = (currentAgent.handoffs ?? []).find((a) => handoffToolName(a.name) === handoffCall.toolName);
        if (!target) {
          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: handoffCall.toolCallId,
                toolName: handoffCall.toolName,
                result: "Error: unknown handoff target",
                isError: true,
              },
            ],
          });
          await saveCheckpoint();
          continue;
        }

        handoffCount++;
        if (handoffCount > maxHandoffs || visitedAgents.has(target.name)) {
          throw new HandoffLoopError([...visitedAgents], target.name);
        }

        const reason = (handoffCall.args as { reason?: string } | undefined)?.reason;
        recordEvent(trace, { type: "handoff", fromAgent: currentAgent.name, toAgent: target.name, reason });
        yield { type: "handoff-started", fromAgent: currentAgent.name, toAgent: target.name, reason };

        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: handoffCall.toolCallId,
              toolName: handoffCall.toolName,
              result: `Handed off to ${target.name}`,
            },
          ],
        });

        visitedAgents.add(target.name);
        trace.agentPath.push(target.name);
        currentAgent = target;
        turnsForCurrentAgent = 0;
        await saveCheckpoint();
        continue;
      }

      // --- normal tool execution ---
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          recordEvent(trace, { type: "tool-call", agentName: currentAgent.name, toolName: call.toolName, args: call.args });
          yield { type: "tool-started", toolName: call.toolName, args: call.args };
        }

        // A generator can only `yield` from its own body, not from inside a
        // nested async callback — so callbacks fired during executeToolCalls
        // (approval requests/resolutions) queue events here, and we drain
        // the queue afterward. recordEvent() itself is synchronous and safe
        // to call directly from the callbacks, so the trace stays accurate
        // and ordered even though the *stream* of AgentEvents surfaces
        // slightly after the fact (approval is blocking either way).
        const queuedEvents: AgentEvent[] = [];

        const toolResults = await executeToolCalls(toolCalls, currentAgent.tools ?? [], {
          agentName: currentAgent.name,
          defaultTimeoutMs: options.defaultToolTimeoutMs,
          toolGuardrails: currentAgent.guardrails?.tool,
          onApprovalRequest: options.onApprovalRequest
            ? async (info) => {
                recordEvent(trace, { type: "approval-requested", agentName: info.agentName, toolName: info.toolName });
                queuedEvents.push({ type: "approval-requested", toolName: info.toolName, args: info.args });
                return options.onApprovalRequest!(info);
              }
            : undefined,
          onApprovalResolved: ({ toolName, approved }) => {
            recordEvent(trace, { type: "approval-resolved", agentName: currentAgent.name, toolName, approved });
            queuedEvents.push({ type: "approval-resolved", toolName, approved });
          },
        });

        for (const event of queuedEvents) yield event;

        for (const r of toolResults) {
          if (r.isError && typeof r.result === "string" && /blocked by tool guardrail/.test(r.result)) {
            const reason = r.result.replace(/^Error: blocked by tool guardrail \(/, "").replace(/\)$/, "");
            recordEvent(trace, { type: "guardrail-triggered", stage: "tool", agentName: currentAgent.name, reason });
            yield { type: "guardrail-triggered", stage: "tool", agentName: currentAgent.name, reason };
          }
        }

        for (const r of toolResults) {
          recordEvent(trace, { type: "tool-result", agentName: currentAgent.name, toolName: r.toolName, isError: !!r.isError });
          yield { type: "tool-completed", toolName: r.toolName, result: r.result, isError: !!r.isError };
        }

        messages = [...messages, { role: "tool", content: toolResults }];
        await saveCheckpoint();
        continue;
      }

      // --- no tool calls, no handoff: this is a final answer ---
      let output: TOutput;
      if (currentAgent.outputSchema) {
        const parsed = await parseJsonAgainstSchema(text, currentAgent.outputSchema);
        if (!parsed.success) {
          messages.push({
            role: "user",
            content: `That output ${parsed.error}. Return corrected JSON only, matching the schema exactly.`,
          });
          await saveCheckpoint();
          continue;
        }
        output = parsed.data;
      } else {
        output = text as unknown as TOutput;
      }

      for (const guardrail of currentAgent.guardrails?.output ?? []) {
        const dummyResult: GenerateResult = {
          model: currentAgent.model,
          text,
          toolCalls: [],
          finishReason: "stop",
          usage,
          messages,
          raw: null,
          object: output,
        };
        const outcome = await guardrail({ result: dummyResult });
        if (!outcome.allowed) {
          const reason = outcome.reason ?? "unspecified";
          recordEvent(trace, { type: "guardrail-triggered", stage: "output", agentName: currentAgent.name, reason });
          yield { type: "guardrail-triggered", stage: "output", agentName: currentAgent.name, reason };
          throw new GuardrailBlockedError(reason, "output");
        }
        if (outcome.modifiedResult) {
          if (outcome.modifiedResult.object !== undefined) output = outcome.modifiedResult.object as TOutput;
          if (outcome.modifiedResult.text !== undefined) text = outcome.modifiedResult.text;
        }
      }

      finishTrace(trace);
      recordEvent(trace, { type: "run-completed" });
      yield { type: "run-completed", output, text, usage: trace.totalUsage };

      await session.appendMessages(messages.slice(newMessagesStart));
      if (checkpointConfig) await checkpointConfig.store.delete(runId);

      return { runId, output, text, finalAgent: currentAgent.name, messages, trace };
    }
  } catch (err) {
    finishTrace(trace);
    const message = err instanceof Error ? err.message : String(err);
    recordEvent(trace, { type: "run-failed", error: message });
    yield { type: "run-failed", error: message };
    // Deliberately NOT deleting the checkpoint here — a failed run is exactly the case
    // resumeAgentStream() exists for. It's only cleared on successful completion above.
    throw new AgentRunError(err, trace);
  }
}

/**
 * Runs an agent to completion, yielding events as it goes (text deltas, tool
 * start/complete, handoffs, guardrail trips) and returning the final RunResult.
 *
 * This function IS the agent loop: it owns tool execution and multi-turn
 * orchestration itself (calling `client.stream()` with `maxToolRoundtrips: 1`
 * each turn) rather than delegating to any one provider's internal loop —
 * so handoffs, tracing, guardrails, and loop-prevention behave identically
 * across OpenAI, Anthropic, and Google.
 *
 * Because this is a generator, its `return` value (the RunResult) is only
 * available by manually driving it with `.next()` — most callers should use
 * the `runAgent()` convenience wrapper below instead, which drains the
 * stream and returns the result directly.
 */
export async function* runAgentStream<TOutput = string>(
  client: Client,
  startAgent: Agent<TOutput>,
  input: string,
  options: RunAgentOptions = {}
): AsyncGenerator<AgentEvent, RunResult<TOutput>, void> {
  const session = options.session ?? createSession(randomUUID(), new InMemorySessionStore());
  const runId = options.checkpoint?.runId ?? randomUUID();

  const trace = createTrace(runId, startAgent.name);
  yield { type: "run-started", runId, agentName: startAgent.name };

  const priorMessages = await session.getMessages();
  const newMessagesStart = priorMessages.length;
  const messages: Message[] = [...priorMessages, { role: "user", content: input }];

  const state: RunLoopState = {
    runId,
    trace,
    messages,
    currentAgent: startAgent,
    turnsForCurrentAgent: 0,
    totalTurns: 0,
    handoffCount: 0,
    visitedAgents: new Set<string>([startAgent.name]),
    newMessagesStart,
  };

  return yield* runLoop<TOutput>(client, session, options, state);
}

/**
 * Resumes a run from a `RunCheckpoint` saved via `RunAgentOptions.checkpoint` — after a crash,
 * a process restart, or any other interruption partway through `runAgentStream()`/`runAgent()`.
 *
 * You must pass the SAME root agent (with the same `handoffs` tree) the original run used —
 * agent definitions (instructions, tools, code) aren't part of a checkpoint, only the run's
 * accumulated state (messages, which agent was active, loop/handoff counters) is. The resumed
 * agent is located by name within `startAgent`'s handoff tree via a depth-first search.
 *
 * From the caller's perspective this behaves exactly like `runAgentStream()` — same event
 * types, same `RunResult` shape — it just starts mid-conversation instead of from a fresh
 * `input` string.
 */
export async function* resumeAgentStream<TOutput = string>(
  client: Client,
  startAgent: Agent<TOutput>,
  options: RunAgentOptions & { checkpoint: { store: RunCheckpointStore; runId: string } }
): AsyncGenerator<AgentEvent, RunResult<TOutput>, void> {
  const checkpoint = await options.checkpoint.store.load(options.checkpoint.runId);
  if (!checkpoint) {
    throw new CheckpointNotFoundError(`No checkpoint found for runId "${options.checkpoint.runId}" — cannot resume.`);
  }

  const resumedAgent = findAgentByName(startAgent, checkpoint.agentName);
  if (!resumedAgent) {
    throw new CheckpointNotFoundError(
      `Checkpoint references agent "${checkpoint.agentName}", which isn't reachable from the agent passed ` +
        `to resumeAgentStream() (checked "${startAgent.name}" and its handoffs). Pass the same root agent ` +
        `(with the same handoffs) the original run used.`
    );
  }

  const session = options.session ?? createSession(randomUUID(), new InMemorySessionStore());

  yield { type: "run-resumed", runId: checkpoint.runId, agentName: resumedAgent.name };

  const state: RunLoopState = {
    runId: checkpoint.runId,
    trace: checkpoint.trace,
    messages: checkpoint.messages,
    currentAgent: resumedAgent,
    turnsForCurrentAgent: checkpoint.turnsForCurrentAgent,
    totalTurns: checkpoint.totalTurns,
    handoffCount: checkpoint.handoffCount,
    visitedAgents: new Set(checkpoint.visitedAgents),
    newMessagesStart: checkpoint.newMessagesStart,
  };

  return yield* runLoop<TOutput>(client, session, options, state);
}

/**
 * Convenience wrapper around `runAgentStream()` for callers who just want
 * the final result without consuming events one by one.
 */
export async function runAgent<TOutput = string>(
  client: Client,
  agent: Agent<TOutput>,
  input: string,
  options: RunAgentOptions = {}
): Promise<RunResult<TOutput>> {
  const gen = runAgentStream(client, agent, input, options);
  let step = await gen.next();
  while (!step.done) {
    step = await gen.next();
  }
  return step.value;
}

/** Convenience wrapper around `resumeAgentStream()` for callers who just want the final result. */
export async function resumeAgent<TOutput = string>(
  client: Client,
  agent: Agent<TOutput>,
  options: RunAgentOptions & { checkpoint: { store: RunCheckpointStore; runId: string } }
): Promise<RunResult<TOutput>> {
  const gen = resumeAgentStream(client, agent, options);
  let step = await gen.next();
  while (!step.done) {
    step = await gen.next();
  }
  return step.value;
}
