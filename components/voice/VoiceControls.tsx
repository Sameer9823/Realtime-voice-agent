"use client";

import type { VoiceState } from "@/lib/voice/types";

/**
 * Start/end controls.
 *
 * The microphone button is the only required interaction. There is deliberately no "stop speaking"
 * button: barge-in is handled by the conversation, not by the user pressing anything.
 */

export interface VoiceControlsProps {
  active: boolean;
  state: VoiceState;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onStart(): void;
  onEnd(): void;
}

export function VoiceControls({ active, state, busy, disabled, disabledReason, onStart, onEnd }: VoiceControlsProps) {
  const connecting = state === "connecting" || state === "reconnecting";

  return (
    <div className="controls">
      <button
        type="button"
        className={`mic-button ${active ? "mic-button-live" : ""}`}
        onClick={active ? onEnd : onStart}
        disabled={disabled || (busy && !active)}
        aria-pressed={active}
        aria-label={active ? "End conversation" : "Start conversation"}
        title={active ? "End conversation" : "Start conversation"}
      >
        <span className="mic-ring" aria-hidden="true" />
        {active ? (
          <svg viewBox="0 0 24 24" className="mic-icon" aria-hidden="true">
            <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="mic-icon" aria-hidden="true">
            <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Z" />
            <path d="M5.5 11a.75.75 0 0 1 1.5 0 5 5 0 0 0 10 0 .75.75 0 0 1 1.5 0 6.5 6.5 0 0 1-5.75 6.45V20a.75.75 0 0 1-1.5 0v-2.55A6.5 6.5 0 0 1 5.5 11Z" />
          </svg>
        )}
      </button>

      <div className="controls-label">
        {connecting ? (
          <span className="controls-hint">{state === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span>
        ) : active ? (
          <button type="button" className="text-button" onClick={onEnd}>
            End conversation
          </button>
        ) : (
          <span className="controls-hint">{disabled ? (disabledReason ?? "Unavailable") : "Start conversation"}</span>
        )}
      </div>
    </div>
  );
}