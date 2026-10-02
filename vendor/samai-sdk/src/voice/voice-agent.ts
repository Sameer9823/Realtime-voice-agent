import { randomUUID } from "../uuid.js";
import type { Session } from "../session.js";
import { addUsage, createTrace, finishTrace, recordEvent, type RunTrace } from "../trace.js";
import type { VoiceAgentConfig, VoiceAgentEvent, VoiceProvider, VoiceSession } from "./types.js";

export type VoiceAgent = VoiceAgentConfig;

export function defineVoiceAgent(config: VoiceAgentConfig): VoiceAgentConfig {
  if (!config.name || !config.name.trim()) {
    throw new Error("defineVoiceAgent() requires a non-empty `name`");
  }
  if (!config.instructions || !config.instructions.trim()) {
    throw new Error("defineVoiceAgent() requires non-empty `instructions`");
  }
  const voice = {
    interruption: "confidence-gated" as const,
    maxSilenceMs: 700,
    backchannel: false,
    ...(config.voice ?? {}),
  };
  // enforce defaults even if explicit undefined was passed
  if ((voice as any).interruption == null) (voice as any).interruption = "confidence-gated";
  if ((voice as any).maxSilenceMs == null) (voice as any).maxSilenceMs = 700;
  if ((voice as any).backchannel == null) (voice as any).backchannel = false;
  return { ...config, voice };
}

export interface RunVoiceAgentOptions {
  session?: Session;
  onEvent?: (e: VoiceAgentEvent) => void;
  onApprovalRequest?: (req: { toolName: string; args: unknown }) => boolean | Promise<boolean>;
}

export async function runVoiceAgent(
  provider: VoiceProvider,
  config: VoiceAgentConfig,
  options: RunVoiceAgentOptions = {}
): Promise<{ session: VoiceSession; trace: RunTrace }> {
  const trace = createTrace(randomUUID(), config.name);

  const voiceSession = await provider.connect({
    agent: config,
    session: options.session,
    onApprovalRequest: options.onApprovalRequest
      ? (req) => Promise.resolve(options.onApprovalRequest!(req))
      : undefined,
  });

  const forward = (e: VoiceAgentEvent) => {
    switch (e.type) {
      case "user-speech-ended":
        recordEvent(trace, { type: "voice-turn", agentName: config.name, transcript: e.transcript });
        break;
      case "interruption":
        recordEvent(trace, { type: "interruption", agentName: config.name, reason: e.reason });
        break;
      case "clarification-requested":
        recordEvent(trace, { type: "clarification", agentName: config.name, question: e.question });
        break;
      case "goal-updated":
        recordEvent(trace, { type: "goal-update", agentName: config.name, goal: e.goal, status: e.status });
        break;
      case "run-completed":
        if ((e as any).usage) addUsage(trace, (e as any).usage);
        recordEvent(trace, { type: "run-completed" });
        finishTrace(trace);
        break;
      case "run-failed": {
        const msg = (e as any).error instanceof Error ? (e as any).error.message : String((e as any).error);
        recordEvent(trace, { type: "run-failed", error: msg });
        finishTrace(trace);
        break;
      }
      default:
        break;
    }
    if (options.onEvent) options.onEvent(e);
  };

  const eventTypes: VoiceAgentEvent["type"][] = [
    "user-speech-started",
    "user-speech-ended",
    "user-transcript-delta",
    "agent-thinking",
    "agent-speech-started",
    "agent-audio-chunk",
    "agent-speech-ended",
    "assistant-transcript-delta",
    "assistant-transcript-done",
    "response-cancelled",
    "interruption",
    "tool-started",
    "tool-completed",
    "clarification-requested",
    "goal-updated",
    "connection-state",
    "run-completed",
    "run-failed",
  ];

  for (const t of eventTypes) {
    (voiceSession as any).on(t, forward);
  }

  return { session: voiceSession, trace };
}
