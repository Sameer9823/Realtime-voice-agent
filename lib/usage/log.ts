import type { VoiceAgentEvent } from "samai-sdk/voice";

export type UsageLogEntry = {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  events: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reconnects: number;
  errors: number;
  toolsInvoked: number;
  transports: string[];
};

export type UsageLog = {
  record: (event: VoiceAgentEvent) => void;
  snapshot: () => UsageLogEntry;
};

export function createUsageLog(sessionId: string, now: () => number = Date.now): UsageLog {
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const transports = new Set<string>();

  let events = 0;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let reconnects = 0;
  let errors = 0;
  let toolsInvoked = 0;
  /** True between a reported drop and the recovery, so one drop counts once. */
  let reconnectPending = false;

  return {
    record(event: VoiceAgentEvent): void {
      events += 1;
      switch (event.type) {
        case "run-completed":
          turns += 1;
          inputTokens += event.usage.inputTokens;
          outputTokens += event.usage.outputTokens;
          totalTokens += event.usage.totalTokens;
          break;
        case "connection-state":
          // A drop is reported twice by the SDK — once as `reconnecting`, once as the attempt
          // number on the recovery — so counting both would report every hiccup as two.
          if (event.state === "reconnecting") reconnectPending = true;
          if (event.state === "connected") {
            if (reconnectPending || (event.attempt ?? 0) > 1) reconnects += 1;
            reconnectPending = false;
          }
          if (event.state === "failed") reconnectPending = false;
          transports.add(event.state);
          break;
        case "run-failed":
          errors += 1;
          break;
        case "tool-started":
          toolsInvoked += 1;
          break;
        default:
          break;
      }
    },
    snapshot(): UsageLogEntry {
      const endedAtMs = now();
      return {
        sessionId,
        startedAt,
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: endedAtMs - startedAtMs,
        events,
        turns,
        inputTokens,
        outputTokens,
        totalTokens,
        reconnects,
        errors,
        toolsInvoked,
        transports: [...transports].sort(),
      };
    },
  };
}
