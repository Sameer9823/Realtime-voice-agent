import { writable, type Readable } from "svelte/store";
import type { Agent } from "./agent.js";
import type { Client } from "./client.js";
import type { AgentEvent, RunAgentOptions, RunResult } from "./run.js";
import { runAgentStream } from "./run.js";

export interface AgentState<TOutput = string> {
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

export interface AgentStore<TOutput = string> extends Readable<AgentState<TOutput>> {
  /** Starts a run. Safe to call again once the previous run has finished. */
  run: (input: string, options?: RunAgentOptions) => Promise<RunResult<TOutput> | undefined>;
  /** Resets state back to idle (does not cancel an in-flight run — pass an AbortSignal via `options.signal` for that). */
  reset: () => void;
}

const initialState: AgentState<any> = {
  isRunning: false,
  text: "",
  events: [],
  result: null,
  error: null,
};

/**
 * Drives a SamAI agent run from a Svelte component: a Svelte store (subscribe with `$agent` in a
 * `.svelte` file) plus `run()`/`reset()` methods attached to it. Same underlying behavior as
 * `useAgent()` from `samai-sdk/react`/`samai-sdk/vue` — just exposed as a store instead of React
 * state or Vue refs. It owns no agent-loop logic itself.
 *
 * Usage (in a `.svelte` component):
 *   import { useAgent } from "samai-sdk/svelte";
 *   const agent = useAgent(client, myAgent);
 *   // <button on:click={() => agent.run("What's the weather in Tokyo?")} disabled={$agent.isRunning}>Ask</button>
 *   // <p>{$agent.text}</p>
 */
export function useAgent<TOutput = string>(client: Client, agent: Agent<TOutput>): AgentStore<TOutput> {
  const state = writable<AgentState<TOutput>>(initialState);
  let runId = 0;

  async function run(input: string, options: RunAgentOptions = {}): Promise<RunResult<TOutput> | undefined> {
    const thisRunId = ++runId;
    state.set({ isRunning: true, text: "", events: [], result: null, error: null });

    try {
      const gen = runAgentStream<TOutput>(client, agent, input, options);
      let step = await gen.next();
      while (!step.done) {
        const event = step.value;
        // Ignore stale events if a newer run() call has started since this one began.
        if (thisRunId === runId) {
          state.update((prev) => ({
            ...prev,
            text: event.type === "text-delta" ? prev.text + event.textDelta : prev.text,
            events: [...prev.events, event],
          }));
        }
        step = await gen.next();
      }
      if (thisRunId === runId) {
        state.update((prev) => ({ ...prev, isRunning: false, result: step.value as RunResult<TOutput> }));
      }
      return step.value;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (thisRunId === runId) {
        state.update((prev) => ({ ...prev, isRunning: false, error }));
      }
      return undefined;
    }
  }

  function reset(): void {
    runId++; // invalidate any run still in flight
    state.set(initialState);
  }

  return { subscribe: state.subscribe, run, reset };
}
