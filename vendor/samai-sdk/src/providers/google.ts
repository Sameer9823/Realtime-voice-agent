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

interface GoogleProviderConfig {
  apiKey?: string;
}

function toGoogleTools(tools: ToolDefinition[] = []) {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toolParametersJsonSchema(tool),
      })),
    },
  ];
}

function toGoogleContents(messages: Message[]): any[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((msg) => {
      const role = msg.role === "assistant" ? "model" : "user";

      if (typeof msg.content === "string") {
        return { role, parts: [{ text: msg.content }] };
      }

      const parts = msg.content
        .map((p) => {
          if (p.type === "text") return { text: p.text };
          if (p.type === "image")
            return /^https?:\/\//.test(p.image)
              ? { fileData: { mimeType: p.mimeType ?? "image/png", fileUri: p.image } }
              : { inlineData: { mimeType: p.mimeType ?? "image/png", data: p.image } };
          if (p.type === "tool-call")
            return { functionCall: { name: p.toolName, args: p.args } };
          if (p.type === "tool-result")
            return {
              functionResponse: {
                name: p.toolName,
                response: { result: p.result },
              },
            };
          return null;
        })
        .filter(Boolean);

      return { role, parts };
    });
}

function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content-filter";
    default:
      return "unknown";
  }
}

export function google(config: GoogleProviderConfig = {}): Provider {
  async function getModel(modelName: string, tools?: ToolDefinition[]) {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const client = new GoogleGenerativeAI(config.apiKey ?? "");
    return client.getGenerativeModel({ model: modelName, tools: toGoogleTools(tools) as any });
  }

  async function generate(options: GenerateOptions): Promise<GenerateResult> {
    const maxRoundtrips = options.maxToolRoundtrips ?? 1;
    let messages = [...options.messages];
    let lastUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let raw: unknown;

    const model = await getModel(options.model, options.tools);

    for (let round = 0; round < maxRoundtrips; round++) {
      const response = await model.generateContent({
        contents: toGoogleContents(messages),
        systemInstruction: options.system,
        generationConfig: {
          maxOutputTokens: options.maxTokens,
          temperature: options.temperature,
          topP: options.topP,
          stopSequences: options.stopSequences,
        },
      });
      raw = response;

      const result = response.response;
      const usageMeta = result.usageMetadata;
      lastUsage = {
        inputTokens: usageMeta?.promptTokenCount ?? 0,
        outputTokens: usageMeta?.candidatesTokenCount ?? 0,
        totalTokens: usageMeta?.totalTokenCount ?? 0,
      };

      const candidate = result.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const text = parts
        .filter((p: any) => p.text)
        .map((p: any) => p.text)
        .join("");

      const toolCalls: ToolCallPart[] = parts
        .filter((p: any) => p.functionCall)
        .map((p: any, i: number) => ({
          type: "tool-call",
          toolCallId: `${p.functionCall.name}-${i}`,
          toolName: p.functionCall.name,
          args: p.functionCall.args ?? {},
        }));

      const assistantMsg: Message = {
        role: "assistant",
        content: toolCalls.length > 0 ? [{ type: "text", text }, ...toolCalls] : text,
      };
      messages = [...messages, assistantMsg];

      const finishReason: FinishReason =
        toolCalls.length > 0 ? "tool-calls" : mapFinishReason(candidate?.finishReason);

      if (finishReason !== "tool-calls" || round === maxRoundtrips - 1) {
        return { model: options.model, text, toolCalls, finishReason, usage: lastUsage, messages, raw };
      }

      const toolResults = await executeToolCalls(toolCalls, options.tools);
      messages = [...messages, { role: "tool", content: toolResults }];
    }

    return { model: options.model, text: "", toolCalls: [], finishReason: "unknown", usage: lastUsage, messages, raw };
  }

  async function* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const model = await getModel(options.model, options.tools);

    const response = await model.generateContentStream({
      contents: toGoogleContents(options.messages),
      systemInstruction: options.system,
      generationConfig: {
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        topP: options.topP,
        stopSequences: options.stopSequences,
      },
    });

    let finishReason: FinishReason = "unknown";
    const toolCalls: ToolCallPart[] = [];

    for await (const chunk of response.stream) {
      const candidate = chunk.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];

      for (const p of parts as any[]) {
        if (p.text) yield { type: "text-delta", textDelta: p.text };
        if (p.functionCall) {
          const call: ToolCallPart = {
            type: "tool-call",
            toolCallId: `${p.functionCall.name}-${toolCalls.length}`,
            toolName: p.functionCall.name,
            args: p.functionCall.args ?? {},
          };
          toolCalls.push(call);
          yield { type: "tool-call", toolCall: call };
        }
      }
      if (candidate?.finishReason) {
        finishReason = toolCalls.length > 0 ? "tool-calls" : mapFinishReason(candidate.finishReason);
      }
    }

    const final = await response.response;
    const usageMeta = final.usageMetadata;
    yield {
      type: "finish",
      finishReason,
      usage: {
        inputTokens: usageMeta?.promptTokenCount ?? 0,
        outputTokens: usageMeta?.candidatesTokenCount ?? 0,
        totalTokens: usageMeta?.totalTokenCount ?? 0,
      },
    };
  }

  return { name: "google", generate, stream };
}
