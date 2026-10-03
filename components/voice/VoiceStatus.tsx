"use client";

import type { VoiceError, VoiceState } from "@/lib/voice/types";

/**
 * One line describing what the assistant is doing, plus any error worth surfacing.
 *
 * Errors are shown verbatim because `useVoiceSession` maps every failure to a sentence written for
 * the user — raw exceptions never reach this component. The retry hint names the button that
 * actually retries, which after this redesign is the primary pill rather than a small icon.
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
      <div className="status status-error status-boxed" role="alert">
        <p className="status-message">{error.message}</p>
        {error.retryable && (
          <p className="status-hint">Start a new conversation to try again.</p>
        )}
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
      {state === "listening" && active && (
        <p className="status-hint">Just start talking — you can interrupt at any time.</p>
      )}
    </div>
  );
}

/**
 * Whose turn it is, as a word and a dot.
 *
 * Sits directly under the ring and uses the same two colours as the ring and the transcript, so the
 * speaker is identifiable before any text is read. `none` and the transitional states stay neutral
 * on purpose: giving "connecting" a colour would dilute the one thing the colours mean.
 */
export function TurnIndicator({ turnOwner }: { turnOwner: "none" | "user" | "assistant" }) {
  const label =
    turnOwner === "user" ? "You're speaking" : turnOwner === "assistant" ? "Assistant is speaking" : "Ready";

  return (
    <p className="turn" data-owner={turnOwner}>
      <span className="turn-dot" aria-hidden="true" />
      <span className="turn-name">{label}</span>
    </p>
  );
}