import type { RunTrace } from "./trace.js";

export interface OtelExportOptions {
  /** Tracer name, as passed to `trace.getTracer()`. Default: "samai-sdk". */
  tracerName?: string;
  tracerVersion?: string;
}

/**
 * Converts a finished (or in-progress) `RunTrace` into real OpenTelemetry spans, using
 * whatever tracer provider the host application has already configured (this function
 * doesn't set one up itself — it just calls `trace.getTracer()`, the same as any other
 * instrumented library). Requires the optional `@opentelemetry/api` peer dependency.
 *
 * One root span (`samai.run`) spans the whole run. Model calls and tool calls become their
 * own child spans (paired from the trace's `model-call`/`model-call-completed` and
 * `tool-call`/`tool-result` events, so they carry real durations, not just a timestamp).
 * Handoffs, retries, fallbacks, timeouts, guardrail trips, and approvals become short child
 * spans too, so all of it is visible wherever your traces already go — Honeycomb, Datadog,
 * Grafana Tempo, or anything else that speaks OTLP.
 *
 * Usage:
 *   const result = await runAgent(client, agent, input);
 *   await exportRunTraceToOtel(result.trace);
 */
export async function exportRunTraceToOtel(trace: RunTrace, options: OtelExportOptions = {}): Promise<void> {
  let otel: typeof import("@opentelemetry/api");
  try {
    otel = await import("@opentelemetry/api");
  } catch (err) {
    throw new Error(
      "exportRunTraceToOtel() requires the optional `@opentelemetry/api` package. Install it with `npm install @opentelemetry/api`.",
      { cause: err }
    );
  }

  const tracer = otel.trace.getTracer(options.tracerName ?? "samai-sdk", options.tracerVersion);

  const rootSpan = tracer.startSpan("samai.run", {
    startTime: trace.startedAt,
    attributes: {
      "samai.run_id": trace.runId,
      "samai.agent_path": trace.agentPath.join(" -> "),
    },
  });
  const parentCtx = otel.trace.setSpan(otel.context.active(), rootSpan);

  // The agent loop is strictly sequential — one model call or tool batch in flight at a time
  // per run — so pairing "-call" / "-completed"/"-result" events by simple FIFO queues is
  // sound (no risk of mismatching interleaved concurrent calls, because there are none).
  const pendingModelCalls: { agentName: string; model: string; turn: number; timestamp: number }[] = [];
  const pendingToolCalls: { agentName: string; toolName: string; timestamp: number }[] = [];

  for (const event of trace.events) {
    switch (event.type) {
      case "model-call":
        pendingModelCalls.push(event);
        break;

      case "model-call-completed": {
        const start = pendingModelCalls.shift();
        const span = tracer.startSpan(
          "samai.model_call",
          {
            startTime: start?.timestamp ?? event.timestamp,
            attributes: {
              "samai.agent": event.agentName,
              ...(start ? { "samai.model": start.model, "samai.turn": start.turn } : {}),
              "samai.usage.input_tokens": event.usage.inputTokens,
              "samai.usage.output_tokens": event.usage.outputTokens,
              "samai.usage.total_tokens": event.usage.totalTokens,
            },
          },
          parentCtx
        );
        span.end(event.timestamp);
        break;
      }

      case "tool-call":
        pendingToolCalls.push(event);
        break;

      case "tool-result": {
        const start = pendingToolCalls.shift();
        const span = tracer.startSpan(
          "samai.tool_call",
          {
            startTime: start?.timestamp ?? event.timestamp,
            attributes: { "samai.agent": event.agentName, "samai.tool": event.toolName, "samai.is_error": event.isError },
          },
          parentCtx
        );
        if (event.isError) span.setStatus({ code: otel.SpanStatusCode.ERROR });
        span.end(event.timestamp);
        break;
      }

      case "handoff": {
        const span = tracer.startSpan(
          "samai.handoff",
          {
            startTime: event.timestamp,
            attributes: {
              "samai.from_agent": event.fromAgent,
              "samai.to_agent": event.toAgent,
              ...(event.reason ? { "samai.reason": event.reason } : {}),
            },
          },
          parentCtx
        );
        span.end(event.timestamp);
        break;
      }

      case "retry": {
        const span = tracer.startSpan(
          "samai.retry",
          {
            startTime: event.timestamp,
            attributes: { "samai.agent": event.agentName, "samai.attempt": event.attempt, "samai.delay_ms": event.delayMs, "samai.error": event.error },
          },
          parentCtx
        );
        span.end(event.timestamp);
        break;
      }

      case "fallback": {
        const span = tracer.startSpan(
          "samai.fallback",
          {
            startTime: event.timestamp,
            attributes: { "samai.agent": event.agentName, "samai.failed_provider": event.failedProvider, "samai.next_provider": event.nextProvider },
          },
          parentCtx
        );
        span.end(event.timestamp);
        break;
      }

      case "timeout": {
        const span = tracer.startSpan(
          "samai.timeout",
          { startTime: event.timestamp, attributes: { "samai.agent": event.agentName, "samai.model": event.model, "samai.timeout_ms": event.timeoutMs } },
          parentCtx
        );
        span.setStatus({ code: otel.SpanStatusCode.ERROR });
        span.end(event.timestamp);
        break;
      }

      case "guardrail-triggered": {
        const span = tracer.startSpan(
          "samai.guardrail_triggered",
          { startTime: event.timestamp, attributes: { "samai.agent": event.agentName, "samai.stage": event.stage, "samai.reason": event.reason } },
          parentCtx
        );
        span.setStatus({ code: otel.SpanStatusCode.ERROR });
        span.end(event.timestamp);
        break;
      }

      case "approval-requested": {
        const span = tracer.startSpan(
          "samai.approval_requested",
          { startTime: event.timestamp, attributes: { "samai.agent": event.agentName, "samai.tool": event.toolName } },
          parentCtx
        );
        span.end(event.timestamp);
        break;
      }

      case "approval-resolved": {
        const span = tracer.startSpan(
          "samai.approval_resolved",
          { startTime: event.timestamp, attributes: { "samai.agent": event.agentName, "samai.tool": event.toolName, "samai.approved": event.approved } },
          parentCtx
        );
        span.end(event.timestamp);
        break;
      }

      case "voice-turn": {
        const span = tracer.startSpan("samai.voice_turn", { startTime: event.timestamp, attributes: { "samai.agent": event.agentName, "samai.transcript": event.transcript } }, parentCtx); span.end(event.timestamp); break;
      }
      case "interruption": {
        const span = tracer.startSpan("samai.interruption", { startTime: event.timestamp, attributes: { "samai.agent": event.agentName, "samai.reason": event.reason } }, parentCtx); span.setStatus({ code: otel.SpanStatusCode.ERROR }); span.end(event.timestamp); break;
      }
      case "clarification": {
        const span = tracer.startSpan("samai.clarification", { startTime: event.timestamp, attributes: { "samai.agent": event.agentName, "samai.question": event.question } }, parentCtx); span.end(event.timestamp); break;
      }
      case "goal-update": {
        const span = tracer.startSpan("samai.goal_update", { startTime: event.timestamp, attributes: { "samai.agent": event.agentName, "samai.goal": event.goal, "samai.status": event.status } }, parentCtx); span.end(event.timestamp); break;
      }
      case "run-failed":
        rootSpan.setStatus({ code: otel.SpanStatusCode.ERROR, message: event.error });
        break;

      // "run-started" / "run-completed" carry no extra data beyond what the root span already has.
      default:
        break;
    }
  }

  rootSpan.setAttribute("samai.usage.total_tokens", trace.totalUsage.totalTokens);
  rootSpan.setAttribute("samai.usage.input_tokens", trace.totalUsage.inputTokens);
  rootSpan.setAttribute("samai.usage.output_tokens", trace.totalUsage.outputTokens);
  rootSpan.end(trace.finishedAt ?? Date.now());
}
