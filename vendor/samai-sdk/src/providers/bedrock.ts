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

export interface BedrockProviderConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export function toBedrockTools(tools: ToolDefinition[] = []): any {
  if (tools.length === 0) return undefined;
  return {
    tools: tools.map((tool) => ({
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: { json: toolParametersJsonSchema(tool) },
      },
    })),
  };
}

export function toBedrockMessages(messages: Message[]): any[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((msg) => {
      const role = msg.role === "tool" ? "user" : msg.role === "assistant" ? "assistant" : "user";

      if (typeof msg.content === "string") {
        return { role, content: [{ text: msg.content }] };
      }

      const blocks = msg.content
        .map((p) => {
          if (p.type === "text") return { text: p.text };
          if (p.type === "image") {
            // Bedrock's Converse API only accepts inline bytes, not URLs — callers must
            // pass base64 image data for Bedrock (a URL here would need fetching first).
            const format = (p.mimeType ?? "image/png").split("/")[1] ?? "png";
            return { image: { format, source: { bytes: p.image } } };
          }
          if (p.type === "tool-call")
            return { toolUse: { toolUseId: p.toolCallId, name: p.toolName, input: p.args } };
          if (p.type === "tool-result")
            return {
              toolResult: {
                toolUseId: p.toolCallId,
                content: [{ text: typeof p.result === "string" ? p.result : JSON.stringify(p.result) }],
                status: p.isError ? "error" : "success",
              },
            };
          return null;
        })
        .filter(Boolean);

      return { role, content: blocks };
    });
}

function mapBedrockFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-calls";
    case "content_filtered":
      return "content-filter";
    default:
      return "unknown";
  }
}

function parseBedrockMessage(message: any): { text: string; toolCalls: ToolCallPart[] } {
  let text = "";
  const toolCalls: ToolCallPart[] = [];
  for (const block of message?.content ?? []) {
    if (block.text) text += block.text;
    if (block.toolUse) {
      toolCalls.push({
        type: "tool-call",
        toolCallId: block.toolUse.toolUseId,
        toolName: block.toolUse.name,
        args: block.toolUse.input ?? {},
      });
    }
  }
  return { text, toolCalls };
}

/**
 * AWS Bedrock, via the unified Converse API — works the same way across every Bedrock-hosted
 * model family (Anthropic, Meta Llama, Amazon Titan/Nova, Mistral, etc.), so `model` is
 * whatever Bedrock model ID you've enabled access to, e.g.
 * "anthropic.claude-sonnet-4-6-20260101-v1:0" or "meta.llama3-1-70b-instruct-v1:0".
 *
 * Requires the optional `@aws-sdk/client-bedrock-runtime` peer dependency. Credentials fall
 * back to the standard AWS credential chain (env vars, shared config file, IAM role) if
 * `accessKeyId`/`secretAccessKey` aren't passed explicitly.
 */
export function bedrock(config: BedrockProviderConfig = {}): Provider {
  async function getClient() {
    const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
    return new BedrockRuntimeClient({
      region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
      credentials: config.accessKeyId
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey ?? "",
            sessionToken: config.sessionToken,
          }
        : undefined,
    });
  }

  async function generate(options: GenerateOptions): Promise<GenerateResult> {
    const { ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = await getClient();
    const maxRoundtrips = options.maxToolRoundtrips ?? 1;
    let messages = [...options.messages];
    let lastUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let raw: unknown;

    for (let round = 0; round < maxRoundtrips; round++) {
      const response = await client.send(
        new ConverseCommand({
          modelId: options.model,
          system: options.system ? [{ text: options.system }] : undefined,
          messages: toBedrockMessages(messages),
          toolConfig: toBedrockTools(options.tools),
          inferenceConfig: {
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            topP: options.topP,
            stopSequences: options.stopSequences,
          },
        })
      );
      raw = response;

      const { text, toolCalls } = parseBedrockMessage(response.output?.message);
      lastUsage = {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        totalTokens: response.usage?.totalTokens ?? 0,
      };

      const assistantMsg: Message = {
        role: "assistant",
        content: toolCalls.length > 0 ? [{ type: "text", text }, ...toolCalls] : text,
      };
      messages = [...messages, assistantMsg];

      const finishReason = mapBedrockFinishReason(response.stopReason);

      if (finishReason !== "tool-calls" || toolCalls.length === 0 || round === maxRoundtrips - 1) {
        return { model: options.model, text, toolCalls, finishReason, usage: lastUsage, messages, raw };
      }

      const toolResults = await executeToolCalls(toolCalls, options.tools);
      messages = [...messages, { role: "tool", content: toolResults }];
    }

    return { model: options.model, text: "", toolCalls: [], finishReason: "unknown", usage: lastUsage, messages, raw };
  }

  async function* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { ConverseStreamCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = await getClient();

    const response = await client.send(
      new ConverseStreamCommand({
        modelId: options.model,
        system: options.system ? [{ text: options.system }] : undefined,
        messages: toBedrockMessages(options.messages),
        toolConfig: toBedrockTools(options.tools),
        inferenceConfig: {
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          topP: options.topP,
          stopSequences: options.stopSequences,
        },
      })
    );

    const toolCallBuffers: Record<number, { id: string; name: string; args: string }> = {};
    let finishReason: FinishReason = "unknown";
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    for await (const event of response.stream ?? []) {
      if (event.contentBlockStart?.start?.toolUse) {
        const idx = event.contentBlockStart.contentBlockIndex ?? 0;
        toolCallBuffers[idx] = {
          id: event.contentBlockStart.start.toolUse.toolUseId ?? "",
          name: event.contentBlockStart.start.toolUse.name ?? "",
          args: "",
        };
      }
      if (event.contentBlockDelta?.delta?.text) {
        yield { type: "text-delta", textDelta: event.contentBlockDelta.delta.text };
      }
      if (event.contentBlockDelta?.delta?.toolUse?.input) {
        const idx = event.contentBlockDelta.contentBlockIndex ?? 0;
        if (toolCallBuffers[idx]) toolCallBuffers[idx].args += event.contentBlockDelta.delta.toolUse.input;
      }
      if (event.messageStop?.stopReason) {
        finishReason = mapBedrockFinishReason(event.messageStop.stopReason);
      }
      if (event.metadata?.usage) {
        usage = {
          inputTokens: event.metadata.usage.inputTokens ?? 0,
          outputTokens: event.metadata.usage.outputTokens ?? 0,
          totalTokens: event.metadata.usage.totalTokens ?? 0,
        };
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

    yield { type: "finish", finishReason, usage };
  }

  return { name: "bedrock", generate, stream };
}
