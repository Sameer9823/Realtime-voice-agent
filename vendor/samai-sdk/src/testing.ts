import type { FinishReason, GenerateOptions, GenerateResult, Message, Provider, StreamChunk, ToolCallPart, Usage } from "./types.js";

export interface MockTurn {
  /** Text the mock "says" this turn. Default: "". */
  text?: string;
  /** Tool calls to make this turn. If set, finishReason defaults to "tool-calls" instead of "stop". */
  toolCalls?: { toolName: string; args: Record<string, unknown> }[];
  finishReason?: FinishReason;
  /** Overrides the default mock usage ({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }) for this turn. */
  usage?: Partial<Usage>;
  /** Simulates latency before responding, in ms. */
  delayMs?: number;
  /** Throws this instead of responding — simulates a provider-level failure on this turn. */
  error?: Error;
}

export interface MockProviderConfig {
  name?: string;
  /**
   * Either a fixed sequence of turns — the Nth `generate()`/`stream()` call gets
   * `responses[N]`, and the LAST entry repeats for any calls beyond the list's length — or a
   * function computing a turn from the call index and the actual `GenerateOptions` received,
   * useful when a turn's response needs to depend on what the agent loop actually sent (e.g.
   * to simulate the model reacting to a tool result).
   */
  responses: MockTurn[] | ((callIndex: number, options: GenerateOptions) => MockTurn);
}

export interface MockProvider extends Provider {
  /** Every `GenerateOptions` this provider was called with, in order — inspect this in assertions (e.g. `mock.calls[0].messages`). */
  calls: GenerateOptions[];
  /** Resets the call log and turn index back to the start, so one mock instance can be reused across multiple test cases. */
  reset(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toToolCalls(turn: MockTurn, idPrefix: string): ToolCallPart[] {
  return (turn.toolCalls ?? []).map((tc, i) => ({
    type: "tool-call",
    toolCallId: `${idPrefix}_${i}`,
    toolName: tc.toolName,
    args: tc.args,
  }));
}

function toUsage(turn: MockTurn): Usage {
  return { inputTokens: 10, outputTokens: 5, totalTokens: 15, ...turn.usage };
}

/**
 * A `Provider` implementation for testing agents, tools, handoffs, and guardrails without
 * hitting a real model API. Ships in the SDK so you don't have to hand-roll a fake `Provider`
 * (with all its `generate`/`stream` boilerplate) the way every test in this repo used to.
 *
 * Usage:
 *   const mock = createMockProvider({
 *     responses: [
 *       { toolCalls: [{ toolName: "get_weather", args: { city: "Tokyo" } }] },
 *       { text: "It's 18°C and cloudy in Tokyo." },
 *     ],
 *   });
 *   const client = createClient({ provider: mock });
 *   const result = await runAgent(client, myAgent, "What's the weather in Tokyo?");
 *   expect(mock.calls).toHaveLength(2);
 *   expect(mock.calls[1].messages.at(-1)).toMatchObject({ role: "tool" });
 */
export function createMockProvider(config: MockProviderConfig): MockProvider {
  let callIndex = 0;
  const calls: GenerateOptions[] = [];

  function nextTurn(options: GenerateOptions): MockTurn {
    const turn = Array.isArray(config.responses)
      ? config.responses[Math.min(callIndex, config.responses.length - 1)]
      : config.responses(callIndex, options);
    callIndex++;
    return turn ?? {};
  }

  async function generate(options: GenerateOptions): Promise<GenerateResult> {
    calls.push(options);
    const turn = nextTurn(options);
    if (turn.delayMs) await sleep(turn.delayMs);
    if (turn.error) throw turn.error;

    const toolCalls = toToolCalls(turn, `mock_${calls.length}`);
    const text = turn.text ?? "";
    const usage = toUsage(turn);
    const finishReason: FinishReason = turn.finishReason ?? (toolCalls.length > 0 ? "tool-calls" : "stop");
    const assistantMsg: Message = {
      role: "assistant",
      content: toolCalls.length > 0 ? [{ type: "text", text }, ...toolCalls] : text,
    };

    return { model: options.model, text, toolCalls, finishReason, usage, messages: [...options.messages, assistantMsg], raw: turn };
  }

  async function* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    calls.push(options);
    const turn = nextTurn(options);
    if (turn.delayMs) await sleep(turn.delayMs);
    if (turn.error) {
      yield { type: "error", error: turn.error };
      return;
    }

    if (turn.text) yield { type: "text-delta", textDelta: turn.text };

    const toolCalls = toToolCalls(turn, `mock_${calls.length}`);
    for (const toolCall of toolCalls) yield { type: "tool-call", toolCall };

    const finishReason: FinishReason = turn.finishReason ?? (toolCalls.length > 0 ? "tool-calls" : "stop");
    yield { type: "finish", finishReason, usage: toUsage(turn) };
  }

  return {
    name: config.name ?? "mock",
    generate,
    stream,
    calls,
    reset() {
      callIndex = 0;
      calls.length = 0;
    },
  };
}
