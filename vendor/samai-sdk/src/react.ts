import { useCallback, useRef, useState } from "react";
import type { Agent } from "./agent.js";
import type { Client } from "./client.js";
import type { AgentEvent, RunAgentOptions, RunResult } from "./run.js";
import { runAgentStream } from "./run.js";

export interface UseAgentState<TOutput = string> {
  /** True while a run is in progress. */
  isRunning: boolean;
  /** Text streamed so far for the current/last run (accumulates across text-delta events). */
  text: string;
  /** All events received for the current/last run, in order — handy for rendering a live activity feed. */
  events: AgentEvent[];
  /** The finished result, once the run completes successfully. */
  result: RunResult<TOutput> | null;
  /** Set if the run failed. */
  error: Error | null;
}

export interface UseAgentResult<TOutput = string> extends UseAgentState<TOutput> {
  /** Starts a run. Safe to call again once the previous run has finished. */
  run: (input: string, options?: RunAgentOptions) => Promise<RunResult<TOutput> | undefined>;
  /** Resets state back to idle (does not cancel an in-flight run — pass an AbortSignal via `options.signal` for that). */
  reset: () => void;
}

const initialState: UseAgentState<any> = {
  isRunning: false,
  text: "",
  events: [],
  result: null,
  error: null,
};

/**
 * Drives a SamAI agent run from a React component: call `run(input)`, then render `text`
 * (streams in live), `events` (for a tool-call/handoff activity feed), and `result`/`error`
 * once the run finishes.
 *
 * This is a thin wrapper around `runAgentStream()` — it owns no agent-loop logic itself, so
 * behavior matches calling `runAgentStream()` directly from Node.
 *
 * Usage:
 *   const { run, isRunning, text, events, result, error } = useAgent(client, myAgent);
 *   <button onClick={() => run("What's the weather in Tokyo?")} disabled={isRunning}>Ask</button>
 *   <p>{text}</p>
 */
export function useAgent<TOutput = string>(client: Client, agent: Agent<TOutput>): UseAgentResult<TOutput> {
  const [state, setState] = useState<UseAgentState<TOutput>>(initialState);
  const runIdRef = useRef(0);

  const run = useCallback(
    async (input: string, options: RunAgentOptions = {}) => {
      const thisRunId = ++runIdRef.current;
      setState({ isRunning: true, text: "", events: [], result: null, error: null });

      try {
        const gen = runAgentStream<TOutput>(client, agent, input, options);
        let step = await gen.next();
        while (!step.done) {
          const event = step.value;
          // Ignore stale events if a newer run() call has started since this one began.
          if (thisRunId === runIdRef.current) {
            setState((prev) => ({
              ...prev,
              text: event.type === "text-delta" ? prev.text + event.textDelta : prev.text,
              events: [...prev.events, event],
            }));
          }
          step = await gen.next();
        }
        if (thisRunId === runIdRef.current) {
          setState((prev) => ({ ...prev, isRunning: false, result: step.value }));
        }
        return step.value;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (thisRunId === runIdRef.current) {
          setState((prev) => ({ ...prev, isRunning: false, error }));
        }
        return undefined;
      }
    },
    [client, agent]
  );

  const reset = useCallback(() => {
    runIdRef.current++; // invalidate any run still in flight
    setState(initialState);
  }, []);

  return { ...state, run, reset };
}
