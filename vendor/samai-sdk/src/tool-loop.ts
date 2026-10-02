import type { ToolCallPart, ToolDefinition, ToolGuardrail, ToolResultPart } from "./types.js";

/** Thrown internally by `executeToolCalls` when a tool's `execute()` doesn't finish within its timeout; surfaced to the model as an error tool result, not thrown to the caller. */
export class ToolTimeoutError extends Error {
  constructor(public toolName: string, public timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

export interface ExecuteToolCallsOptions {
  /** Default per-tool execution timeout, in ms, for tools that don't set their own `timeoutMs`. Default: 30000. */
  defaultTimeoutMs?: number;
  /** Runs before each tool call executes; a rejection blocks that one call without failing the whole batch. */
  toolGuardrails?: ToolGuardrail[];
  /**
   * Called when a tool call is marked `requiresApproval`. Must resolve to `true`
   * to allow execution. If omitted, approval-gated calls are rejected by default
   * (fail closed) rather than silently executed.
   */
  onApprovalRequest?: (info: { agentName: string; toolName: string; args: unknown }) => boolean | Promise<boolean>;
  agentName?: string;
  /** Observability hook fired once a call is approved, rejected, or skipped (no handler present). */
  onApprovalResolved?: (info: { toolName: string; approved: boolean }) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError(toolName, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Executes local tool functions for a batch of tool calls the model made.
 * Runs tools concurrently and never throws — failures (validation errors,
 * timeouts, rejected guardrails, denied approvals) are captured as isError
 * tool results so the model can see and react to them.
 *
 * Order per call: tool-guardrail check -> approval gate (if required) ->
 * schema validation -> timed execution.
 */
export async function executeToolCalls(
  toolCalls: ToolCallPart[],
  tools: ToolDefinition[] = [],
  options: ExecuteToolCallsOptions = {}
): Promise<ToolResultPart[]> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;

  return Promise.all(
    toolCalls.map(async (call): Promise<ToolResultPart> => {
      const tool = byName.get(call.toolName);
      if (!tool) {
        return {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: `Error: no tool registered with name "${call.toolName}"`,
          isError: true,
        };
      }

      // --- tool guardrails: reject dangerous calls before they run ---
      for (const guardrail of options.toolGuardrails ?? []) {
        const outcome = await guardrail({
          agentName: options.agentName ?? "",
          toolName: call.toolName,
          args: call.args,
        });
        if (!outcome.allowed) {
          return {
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            result: `Error: blocked by tool guardrail (${outcome.reason ?? "unspecified"})`,
            isError: true,
          };
        }
      }

      try {
        const parsedArgs = tool.parameters.parse(call.args);

        // --- approval gate ---
        const needsApproval =
          typeof tool.requiresApproval === "function"
            ? await tool.requiresApproval(parsedArgs)
            : !!tool.requiresApproval;

        if (needsApproval) {
          const approved = options.onApprovalRequest
            ? await options.onApprovalRequest({
                agentName: options.agentName ?? "",
                toolName: call.toolName,
                args: parsedArgs,
              })
            : false; // fail closed: no approval handler means no approval

          options.onApprovalResolved?.({ toolName: call.toolName, approved });

          if (!approved) {
            return {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              result: options.onApprovalRequest
                ? `Error: tool call "${call.toolName}" was not approved`
                : `Error: tool call "${call.toolName}" requires approval, but no approval handler is configured (pass onApprovalRequest to runAgent options)`,
              isError: true,
            };
          }
        }

        const timeoutMs = tool.timeoutMs ?? defaultTimeoutMs;
        const result = await withTimeout(Promise.resolve(tool.execute(parsedArgs)), timeoutMs, tool.name);
        return {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result,
        };
      } catch (err) {
        return {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    })
  );
}
