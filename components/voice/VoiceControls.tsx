"use client";

import type { VoiceState } from "@/lib/voice/types";
import { MicIcon, StopIcon } from "./icons";

/**
 * The primary control: one large labelled pill that starts or ends the conversation.
 *
 * Previously this was an icon-only circle plus a separate text link, and both were named "End
 * conversation" while a session was live. That is a duplicated accessible name and two targets for
 * one action, so it is now one button whose label is its own visible text.
 *
 * There is deliberately no "stop speaking" control. Barge-in belongs to the conversation: the user
 * talks, and the assistant stops.
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

  // While connecting there is nothing useful to press, so the label says what is happening and the
  // button is disabled — rather than the button quietly switching to "End" and implying it would
  // cancel something that has not finished starting.
  const label = connecting ? "Connecting…" : active ? "End conversation" : "Start conversation";

  return (
    <div className="primary">
      <button
        type="button"
        className="primary-button"
        data-variant={active ? "end" : "start"}
        onClick={active ? onEnd : onStart}
        disabled={disabled || connecting || (busy && !active)}
        aria-label={active ? "End conversation" : "Start conversation"}
      >
        {active ? <StopIcon /> : <MicIcon />}
        {label}
      </button>
      {disabled && disabledReason && <p className="status-hint">{disabledReason}</p>}
    </div>
  );
}