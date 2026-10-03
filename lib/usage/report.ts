import type { UsageLogEntry } from "./log";

/**
 * Shipping a usage record to the server.
 *
 * Reporting is best-effort by design: a voice agent that has finished a good conversation
 * should not surface an error because the metrics ping failed, so every failure here is
 * swallowed after a server-side log line. The fetch is injectable so tests never touch the
 * network.
 */

export type UsageReporterContext = {
  voice?: string;
  model?: string;
  persona?: string;
  language?: string;
};

export type PostUsageOptions = {
  fetchImpl?: typeof fetch;
  context?: UsageReporterContext;
  /** Injected for tests; defaults to the ambient fetch. */
  signal?: AbortSignal;
};

/** Reduces a snapshot to the fields `/api/usage` accepts. */
export function toUsagePayload(entry: UsageLogEntry, context: UsageReporterContext = {}) {
  return {
    sessionId: entry.sessionId,
    turns: entry.turns,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    totalTokens: entry.totalTokens,
    reconnects: entry.reconnects,
    errors: entry.errors,
    toolsInvoked: entry.toolsInvoked,
    durationMs: entry.durationMs,
    transports: entry.transports,
    ...(context.voice ? { voice: context.voice } : {}),
    ...(context.model ? { model: context.model } : {}),
    ...(context.persona ? { persona: context.persona } : {}),
    ...(context.language ? { language: context.language } : {}),
  };
}

/** POSTs the record. Returns whether the server accepted it; never throws. */
export async function postUsage(entry: UsageLogEntry, options: PostUsageOptions = {}): Promise<boolean> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const res = await doFetch("/api/usage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toUsagePayload(entry, options.context)),
      signal: options.signal,
    });
    return res.ok;
  } catch (err) {
    console.warn("[usage] report failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
