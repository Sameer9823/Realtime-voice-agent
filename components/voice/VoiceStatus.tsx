"use client";

import type { VoiceError, VoiceState } from "@/lib/voice/types";

/**
 * One line describing what the assistant is doing, plus any error worth surfacing.
 *
 * Errors are shown verbatim because `useVoiceSession` maps every failure to a sentence written for
 * the user — raw exceptions never reach this component.
 */

const STATUS_TEXT: Record<VoiceState, string> = {
  idle: "Ready when you are",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  listening: "Listening",
  user_speaking: "You're speaking",
  thinking: "Thinking…",
  speaking: "Speaking",
  assistant_speaking: "Speaking",
  interrupting: "Stopping…",
  interrupted: "Interrupted",
  error: "Something went wrong",
};

export interface VoiceStatusProps {
  state: VoiceState;
  error: VoiceError | null;
  toolRunning: boolean;
  active: boolean;
}

export function VoiceStatus({ state, error, toolRunning, active }: VoiceStatusProps) {
  if (error) {
    return (
      <div className="status status-error" role="alert">
        <p className="status-message">{error.message}</p>
        {error.retryable && <p className="status-hint">Press the microphone button to try again.</p>}
      </div>
    );
  }

  const base = active ? STATUS_TEXT[state] : STATUS_TEXT.idle;

  return (
    <div className="status" aria-live="polite">
      <p className="status-message">
        {base}
        {toolRunning && <span className="status-tool"> · using a tool</span>}
      </p>
      {state === "listening" && active && <p className="status-hint">Just start talking — you can interrupt at any time.</p>}
    </div>
  );
}