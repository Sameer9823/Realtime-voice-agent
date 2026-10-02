import type {
  FinishReason,
  GenerateOptions,
  GenerateResult,
  Message,
  Provider,
  StreamChunk,
  ToolCallPart,
  ToolDefinition,
  Usage,
} from "../types.js";
import { executeToolCalls } from "../tool-loop.js";
import { toolParametersJsonSchema } from "../schema-adapter.js";

interface AnthropicProviderConfig {
  apiKey?: string;
  baseURL?: string;
}

export function toAnthropicTools(tools: ToolDefinition[] = [], cache = false) {
  if (tools.length === 0) return undefined;
  const mapped = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toolParametersJsonSchema(tool),
  }));
  // Caching is a breakpoint on the LAST block of a prefix — marking the last tool caches
  // the entire tool list (everything up to and including it) as one reusable unit.
  if (cache && mapped.length > 0) {
    (mapped[mapped.length - 1] as any).cache_control = { type: "ephemeral" };
  }
  return mapped;
}

export function toAnthropicSystem(system: string | undefined, cache: boolean): any {
  if (!system) return undefined;
  if (!cache) return system;
  // As an array-of-blocks with cache_control, this system prompt becomes a reusable prefix —
  // subsequent calls with the same tools+system pay only for a cache read, not full input
  // processing, as long as they land within Anthropic's cache TTL (default ~5 minutes).
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}

function toAnthropicMessages(messages: Message[]): any[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((msg) => {
      if (typeof msg.content === "string") {
        return { role: msg.role === "tool" ? "user" : msg.role, content: msg.content };
      }

      const blocks = msg.content
        .map((p) => {
          if (p.type === "text") return { type: "text", text: p.text };
          if (p.type === "image")
            return {
              type: "image",
              source: /^https?:\/\//.test(p.image)
                ? { type: "url", url: p.image }
                : { type: "base64", media_type: p.mimeType ?? "image/png", data: p.image },
            };
          if (p.type === "tool-call")
            return { type: "tool_use", id: p.toolCallId, name: p.toolName, input: p.args };
          if (p.type === "tool-result")
            return {
              type: "tool_result",
              tool_use_id: p.toolCallId,
              content: typeof p.result === "string" ? p.result : JSON.stringify(p.result),
              is_error: p.isError,
            };
          return null;
        })
        .filter(Boolean);

      // tool results are conceptually a "user" turn in Anthropic's API
      const role = msg.role === "tool" ? "user" : msg.role;
      return { role, content: blocks };
    });
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-calls";
    default:
      return "unknown";
  }
}

export function anthropic(config: AnthropicProviderConfig = {}): Provider {
  async function getClient() {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    return new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  async function generate(options: GenerateOptions): Promise<GenerateResult> {
    const client = await getClient();
    const maxRoundtrips = options.maxToolRoundtrips ?? 1;
    let messages = [...options.messages];
    let lastUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let raw: unknown;

    for (let round = 0; round < maxRoundtrips; round++) {
      const response = await client.messages.create({
        model: options.model,
        system: toAnthropicSystem(options.system, options.promptCaching ?? false),
        messages: toAnthropicMessages(messages),
        tools: toAnthropicTools(options.tools, options.promptCaching ?? false) as any,
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature,
        top_p: options.topP,
        stop_sequences: options.stopSequences,
      });
      raw = response;

      lastUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        cacheWriteTokens: (response.usage as any).cache_creation_input_tokens ?? undefined,
        cacheReadTokens: (response.usage as any).cache_read_input_tokens ?? undefined,
      };

      const text = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");

      const toolCalls: ToolCallPart[] = response.content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({
          type: "tool-call",
          toolCallId: b.id,
          toolName: b.name,
          args: b.input,
        }));

      const assistantMsg: Message = {
        role: "assistant",
        content: toolCalls.length > 0 ? [{ type: "text", text }, ...toolCalls] : text,
      };
      messages = [...messages, assistantMsg];

      const finishReason = mapFinishReason(response.stop_reason);

      if (finishReason !== "tool-calls" || toolCalls.length === 0 || round === maxRoundtrips - 1) {
        return { model: options.model, text, toolCalls, finishReason, usage: lastUsage, messages, raw };
      }

      const toolResults = await executeToolCalls(toolCalls, options.tools);
      messages = [...messages, { role: "tool", content: toolResults }];
    }

    return { model: options.model, text: "", toolCalls: [], finishReason: "unknown", usage: lastUsage, messages, raw };
  }

  async function* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const client = await getClient();

    const response = client.messages.stream({
      model: options.model,
      system: toAnthropicSystem(options.system, options.promptCaching ?? false),
      messages: toAnthropicMessages(options.messages),
      tools: toAnthropicTools(options.tools, options.promptCaching ?? false) as any,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature,
      top_p: options.topP,
      stop_sequences: options.stopSequences,
    });

    const toolCallBuffers: Record<number, { id: string; name: string; args: string }> = {};
    let cacheWriteTokens: number | undefined;
    let cacheReadTokens: number | undefined;

    for await (const event of response) {
      if (event.type === "message_start") {
        const usage = (event.message as any)?.usage;
        cacheWriteTokens = usage?.cache_creation_input_tokens ?? undefined;
        cacheReadTokens = usage?.cache_read_input_tokens ?? undefined;
      }
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        toolCallBuffers[event.index] = {
          id: event.content_block.id,
          name: event.content_block.name,
          args: "",
        };
      }
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text-delta", textDelta: event.delta.text };
        }
        if (event.delta.type === "input_json_delta") {
          if (toolCallBuffers[event.index]) {
            toolCallBuffers[event.index].args += event.delta.partial_json;
          }
        }
      }
      if (event.type === "message_delta") {
        const finishReason = mapFinishReason((event.delta as any).stop_reason);
        if (finishReason === "tool-calls") {
          for (const buf of Object.values(toolCallBuffers)) {
            yield {
              type: "tool-call",
              toolCall: {
                type: "tool-call",
                toolCallId: buf.id,
                toolName: buf.name,
                args: JSON.parse(buf.args || "{}"),
              },
            };
          }
        }
        yield {
          type: "finish",
          finishReason,
          usage: {
            inputTokens: 0,
            outputTokens: (event.usage as any)?.output_tokens ?? 0,
            totalTokens: (event.usage as any)?.output_tokens ?? 0,
            cacheWriteTokens,
            cacheReadTokens,
          },
        };
      }
    }
  }

  return { name: "anthropic", generate, stream };
}
