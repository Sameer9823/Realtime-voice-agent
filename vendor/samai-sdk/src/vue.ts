import { ref, shallowRef, type Ref, type ShallowRef } from "vue";
import type { Agent } from "./agent.js";
import type { Client } from "./client.js";
import type { AgentEvent, RunAgentOptions, RunResult } from "./run.js";
import { runAgentStream } from "./run.js";

export interface UseAgentReturn<TOutput = string> {
  /** True while a run is in progress. */
  isRunning: Ref<boolean>;
  /** Text streamed so far for the current/last run (accumulates across text-delta events). */
  text: Ref<string>;
  /** All events received for the current/last run, in order — handy for rendering a live activity feed. */
  events: Ref<AgentEvent[]>;
  /** The finished result, once the run completes successfully. */
  result: ShallowRef<RunResult<TOutput> | null>;
  /** Set if the run failed. */
  error: ShallowRef<Error | null>;
  /** Starts a run. Safe to call again once the previous run has finished. */
  run: (input: string, options?: RunAgentOptions) => Promise<RunResult<TOutput> | undefined>;
  /** Resets state back to idle (does not cancel an in-flight run — pass an AbortSignal via `options.signal` for that). */
  reset: () => void;
}

/**
 * Drives a SamAI agent run from a Vue 3 component (Composition API): call `run(input)`, then
 * template-bind `text` (streams in live), `events` (for a tool-call/handoff activity feed), and
 * `result`/`error` once the run finishes.
 *
 * This is a thin wrapper around `runAgentStream()` — same underlying behavior as `useAgent()`
 * from `samai-sdk/react`, just exposed as Vue refs instead of React state. It owns no agent-loop
 * logic itself.
 *
 * Usage (in a `<script setup>` component):
 *   import { useAgent } from "samai-sdk/vue";
 *   const { run, isRunning, text, events, result, error } = useAgent(client, myAgent);
 *   // <button @click="run('What's the weather in Tokyo?')" :disabled="isRunning">Ask</button>
 *   // <p>{{ text }}</p>
 */
export function useAgent<TOutput = string>(client: Client, agent: Agent<TOutput>): UseAgentReturn<TOutput> {
  const isRunning = ref(false);
  const text = ref("");
  const events = ref<AgentEvent[]>([]);
  const result = shallowRef<RunResult<TOutput> | null>(null);
  const error = shallowRef<Error | null>(null);

  let runId = 0;

  async function run(input: string, options: RunAgentOptions = {}): Promise<RunResult<TOutput> | undefined> {
    const thisRunId = ++runId;
    isRunning.value = true;
    text.value = "";
    events.value = [];
    result.value = null;
    error.value = null;

    try {
      const gen = runAgentStream<TOutput>(client, agent, input, options);
      let step = await gen.next();
      while (!step.done) {
        const event = step.value;
        // Ignore stale events if a newer run() call has started since this one began.
        if (thisRunId === runId) {
          if (event.type === "text-delta") text.value += event.textDelta;
          events.value.push(event);
        }
        step = await gen.next();
      }
      if (thisRunId === runId) {
        isRunning.value = false;
        result.value = step.value;
      }
      return step.value;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (thisRunId === runId) {
        isRunning.value = false;
        error.value = e;
      }
      return undefined;
    }
  }

  function reset(): void {
    runId++; // invalidate any run still in flight
    isRunning.value = false;
    text.value = "";
    events.value = [];
    result.value = null;
    error.value = null;
  }

  return { isRunning, text, events, result, error, run, reset };
}
