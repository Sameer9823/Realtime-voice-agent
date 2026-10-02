import type { z } from "zod";

// ---------- Messages ----------

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  /** Base64 string (no data: prefix) or a public URL */
  image: string;
  mimeType?: string;
}

export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart;

export interface Message {
  role: Role;
  content: string | ContentPart[];
  /** Optional name, used by some providers for tool/function messages */
  name?: string;
}

// ---------- Tools ----------

export interface ToolDefinition<Args = any, Result = any> {
  name: string;
  description: string;
  /** zod schema describing the arguments the model must supply */
  parameters: z.ZodType<Args>;
  /** Executed locally when the model calls this tool */
  execute: (args: Args) => Promise<Result> | Result;
  /**
   * Marks this tool as requiring human sign-off before it runs. Pass `true` to
   * always require approval, or a predicate to require it conditionally based
   * on the parsed args (e.g. only for destructive parameter values).
   *
   * When a call requires approval, the run loop invokes `onApprovalRequest`
   * (see `RunAgentOptions`) and blocks execution until it resolves. If no
   * `onApprovalRequest` handler is supplied, the call is rejected by default —
   * "fail closed" rather than silently executing a risky tool.
   */
  requiresApproval?: boolean | ((args: Args) => boolean | Promise<boolean>);
  /** Per-tool execution timeout, in ms. Falls back to the run/global default if unset. */
  timeoutMs?: number;
  /**
   * Escape hatch for tools whose parameter shape is already known as a JSON Schema object
   * rather than a zod schema — e.g. tools pulled from an MCP server via `createMCPClient().tools()`.
   * When set, providers send this JSON Schema to the model instead of deriving one from
   * `parameters` via `zodToJsonSchema()`. `parameters` should still be a schema whose `.parse()`
   * does reasonable runtime validation (or a permissive passthrough), since the tool-call loop
   * always validates against it before `execute()` runs.
   */
  rawJsonSchema?: unknown;
}

// ---------- Tool guardrails ----------

export interface ToolGuardrailContext {
  agentName: string;
  toolName: string;
  args: unknown;
}

/** Runs before a tool call executes. Returning `allowed: false` blocks the call and feeds the reason back to the model as a tool error instead of running it. */
export type ToolGuardrail = (
  ctx: ToolGuardrailContext
) => Promise<GuardrailResult> | GuardrailResult;

/**
 * Defines a tool with full type inference from its zod `parameters` schema — `execute`'s `args`
 * (and `requiresApproval`'s, if used) are inferred automatically, no manual typing or casts needed.
 *
 * Inference is done by pinning `Schema` itself as the generic (not `Args` nested inside
 * `z.ZodType<Args, Def, Input>`) and deriving `Args` from it via `z.infer<Schema>`. Asking
 * TypeScript to solve for `Args` by unifying a concrete `ZodObject` against `z.ZodType<Args>`
 * requires reasoning through zod's `Def`/`Input` type parameters too, which is enough nested
 * generic work to occasionally throw `TS2589: Type instantiation is excessively deep` and fall
 * back to `unknown` — this shape avoids that by only ever inferring one concrete type at a time.
 */
export function defineTool<Schema extends z.ZodType, Result = unknown>(tool: {
  name: string;
  description: string;
  /** zod schema describing the arguments the model must supply */
  parameters: Schema;
  /** Executed locally when the model calls this tool */
  execute: (args: z.infer<Schema>) => Promise<Result> | Result;
  /**
   * Marks this tool as requiring human sign-off before it runs. Pass `true` to
   * always require approval, or a predicate to require it conditionally based
   * on the parsed args (e.g. only for destructive parameter values).
   *
   * When a call requires approval, the run loop invokes `onApprovalRequest`
   * (see `RunAgentOptions`) and blocks execution until it resolves. If no
   * `onApprovalRequest` handler is supplied, the call is rejected by default —
   * "fail closed" rather than silently executing a risky tool.
   */
  requiresApproval?: boolean | ((args: z.infer<Schema>) => boolean | Promise<boolean>);
  /** Per-tool execution timeout, in ms. Falls back to the run/global default if unset. */
  timeoutMs?: number;
}): ToolDefinition<z.infer<Schema>, Result> {
  return tool as ToolDefinition<z.infer<Schema>, Result>;
}

/** Recursively makes every field optional — used for the partial objects streamObject() emits mid-stream. */
export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

// ---------- Generation options / results ----------

export interface GenerateOptions {
  model: string;
  messages: Message[];
  system?: string;
  tools?: ToolDefinition[];
  /** How many times to auto-execute tool calls and feed results back. Default 1 (no auto loop). */
  maxToolRoundtrips?: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
  /** Aborts the call if no response is received within this many ms. Enforced by `withTimeout()`; providers themselves don't apply it. */
  timeoutMs?: number;
  /**
   * Marks the system prompt (and tool definitions, if present) as cacheable. Currently
   * honored by `anthropic()` — it adds Anthropic prompt-caching breakpoints so a static
   * system prompt + tool list isn't re-processed (and re-billed at full price) on every
   * turn of a multi-turn agent loop. Ignored by providers that don't support this (a no-op,
   * not an error) — OpenAI/Groq/etc. cache automatically server-side above a token threshold
   * with no client-side configuration needed.
   */
  promptCaching?: boolean;
  /**
   * Per-call observability hooks for resilience wrappers (`withRetry`/`withFallback`/`withTimeout`).
   * These fire IN ADDITION to any hooks configured when the wrapper was created (e.g. via
   * `createResilientProvider()`), so callers like the agent run loop can trace individual
   * retries/fallbacks/timeouts without the provider setup needing to know about tracing.
   */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
  onFallback?: (info: { failedProvider: string; nextProvider: string; error: unknown }) => void;
  onTimeout?: (info: { model: string; timeoutMs: number }) => void;
  /**
   * Free-form per-call context that isn't sent to the provider — carried through the client so
   * wrappers can key off it, e.g. `{ sessionId, userId }` for `createUsageLedger().wrapProvider()`
   * to attribute cost/token spend to the right session or user.
   */
  metadata?: Record<string, unknown>;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "unknown";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Tokens written to the prompt cache on this call (only set by providers that support caching, and only when it happened). */
  cacheWriteTokens?: number;
  /** Tokens read from the prompt cache on this call — the tokens you didn't pay full price for. */
  cacheReadTokens?: number;
}

export interface GenerateResult {
  model: string;
  text: string;
  toolCalls: ToolCallPart[];
  finishReason: FinishReason;
  usage: Usage;
  /** Full message history including any tool roundtrips performed */
  messages: Message[];
  /** Raw provider response, for escape-hatch access */
  raw: unknown;
  /** Populated by a schema guardrail once the text has been parsed/validated as JSON */
  object?: unknown;
}

// ---------- Streaming ----------

export type StreamChunk =
  | { type: "text-delta"; textDelta: string }
  | { type: "tool-call"; toolCall: ToolCallPart }
  | { type: "tool-result"; toolResult: ToolResultPart }
  | { type: "finish"; finishReason: FinishReason; usage: Usage }
  | { type: "error"; error: unknown };

// ---------- Provider interface ----------

export interface Provider {
  /** Provider identifier, e.g. "openai", "anthropic", "google", "groq", "mistral", "ollama", "azure-openai", "bedrock", or a custom name for your own Provider implementation. */
  name: string;
  generate(options: GenerateOptions): Promise<GenerateResult>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

// ---------- Guardrails (extension point, implemented in later phase) ----------

export interface InputGuardrailContext {
  messages: Message[];
}

export interface OutputGuardrailContext {
  result: GenerateResult;
}

export interface GuardrailResult {
  /** If false, the call is blocked */
  allowed: boolean;
  reason?: string;
  /** Optionally rewrite messages/result before continuing */
  modifiedMessages?: Message[];
  modifiedResult?: GenerateResult;
}

export type InputGuardrail = (
  ctx: InputGuardrailContext
) => Promise<GuardrailResult> | GuardrailResult;

export type OutputGuardrail = (
  ctx: OutputGuardrailContext
) => Promise<GuardrailResult> | GuardrailResult;
