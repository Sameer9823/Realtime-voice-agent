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

export interface OpenAICompatibleConfig {
  /** Provider name, shown in traces/errors (e.g. "groq", "mistral", "ollama"). */
  name: string;
  apiKey?: string;
  /** Base URL of the OpenAI-compatible endpoint, e.g. "https://api.groq.com/openai/v1". */
  baseURL?: string;
  /**
   * Most cloud APIs require a real key. Local/self-hosted endpoints (like Ollama) accept
   * any non-empty string, so pass `false` here to avoid throwing when none is configured.
   */
  requireApiKey?: boolean;
  defaultHeaders?: Record<string, string>;
}

export function toOpenAITools(tools: ToolDefinition[] = []) {
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toolParametersJsonSchema(tool),
    },
  }));
}

export function toOpenAIMessages(messages: Message[], system?: string): any[] {
  const out: any[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Structured content: split into text/image parts, tool calls, tool results
    const textParts = msg.content.filter((p) => p.type === "text");
    const toolCalls = msg.content.filter((p) => p.type === "tool-call") as any[];
    const toolResults = msg.content.filter((p) => p.type === "tool-result") as any[];

    if (msg.role === "assistant" && toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: textParts.map((p: any) => p.text).join("") || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.toolCallId,
          type: "function",
          function: { name: tc.toolName, arguments: JSON.stringify(tc.args) },
        })),
      });
      continue;
    }

    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: tr.toolCallId,
          content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
        });
      }
      continue;
    }

    const contentArr = msg.content
      .map((p) => {
        if (p.type === "text") return { type: "text", text: p.text };
        if (p.type === "image")
          return {
            type: "image_url",
            image_url: { url: p.image.startsWith("http") ? p.image : `data:${p.mimeType ?? "image/png"};base64,${p.image}` },
          };
        return null;
      })
      .filter(Boolean);

    out.push({ role: msg.role, content: contentArr });
  }

  return out;
}

export function mapOpenAIFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    default:
      return "unknown";
  }
}

/**
 * Builds a `Provider` from anything that exposes the OpenAI SDK's
 * `chat.completions.create()` shape — used by `openai()`, `groq()`, `mistral()`,
 * `ollama()`, and `azureOpenAI()` so the tool-call loop, streaming, and finish-reason
 * mapping are implemented exactly once.
 */
export function buildOpenAIStyleProvider(name: string, getClient: () => Promise<any>): Provider {
  async function generate(options: GenerateOptions): Promise<GenerateResult> {
    const client = await getClient();
    const maxRoundtrips = options.maxToolRoundtrips ?? 1;
    let messages = [...options.messages];
    let lastUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let raw: unknown;

    for (let round = 0; round < maxRoundtrips; round++) {
      const response = await client.chat.completions.create({
        model: options.model,
        messages: toOpenAIMessages(messages, options.system),
        tools: toOpenAITools(options.tools),
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        top_p: options.topP,
        stop: options.stopSequences,
      });
      raw = response;

      const choice = response.choices[0];
      const usage = response.usage;
      lastUsage = {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      };

      const text = choice.message.content ?? "";
      const toolCalls: ToolCallPart[] = (choice.message.tool_calls ?? []).map((tc: any) => ({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: tc.function.name,
        args: JSON.parse(tc.function.arguments || "{}"),
      }));

      const assistantMsg: Message = {
        role: "assistant",
        content: toolCalls.length > 0 ? [{ type: "text", text }, ...toolCalls] : text,
      };
      messages = [...messages, assistantMsg];

      const finishReason = mapOpenAIFinishReason(choice.finish_reason);

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
    const messages = toOpenAIMessages(options.messages, options.system);

    const response = await client.chat.completions.create({
      model: options.model,
      messages,
      tools: toOpenAITools(options.tools),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      stop: options.stopSequences,
      stream: true,
    });

    const toolCallBuffers: Record<number, { id: string; name: string; args: string }> = {};
    let finishReason: FinishReason = "unknown";

    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta;
      const rawFinish = chunk.choices[0]?.finish_reason;
      if (rawFinish) finishReason = mapOpenAIFinishReason(rawFinish);

      if (delta?.content) {
        yield { type: "text-delta", textDelta: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallBuffers[idx]) {
            toolCallBuffers[idx] = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
          }
          if (tc.function?.arguments) toolCallBuffers[idx].args += tc.function.arguments;
        }
      }
    }

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

    yield {
      type: "finish",
      finishReason,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }

  return { name, generate, stream };
}

/** Builds a provider for any OpenAI-compatible HTTP API by pointing the official `openai` SDK at a different `baseURL`. */
export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): Provider {
  return buildOpenAIStyleProvider(config.name, async () => {
    const { default: OpenAI } = await import("openai");
    const apiKey = config.apiKey ?? (config.requireApiKey === false ? "not-needed" : undefined);
    return new OpenAI({ apiKey, baseURL: config.baseURL, defaultHeaders: config.defaultHeaders });
  });
}
