"use client";

import { useCallback, useEffect, useState } from "react";
import type { TranscriptEntry } from "@/lib/voice/types";
import type { MediaDevicesResult } from "@/lib/voice/use-media-devices";

/**
 * Controls for a live session: mute, push-to-talk, device pickers, and a typed-turn fallback.
 *
 * Every control is a real focusable element with an accessible name, so the whole panel is usable
 * from the keyboard. Push-to-talk additionally listens for Space globally while enabled, which is
 * why the button keeps a visible pressed state as well as the keyboard path.
 */

export interface ExtendedControlsProps {
  active: boolean;
  muted: boolean;
  pushToTalk: boolean;
  talking: boolean;
  transcript: TranscriptEntry[];
  devices: MediaDevicesResult;
  remainingMs: number | null;
  idleWarning: boolean;
  onMutedChange(muted: boolean): void;
  onPushToTalkChange(enabled: boolean): void;
  onTalkingChange(talking: boolean): void;
  onSendText(text: string): boolean;
  formatCountdown(ms: number): string;
}

export function ExtendedControls({
  active,
  muted,
  pushToTalk,
  talking,
  transcript,
  devices,
  remainingMs,
  idleWarning,
  onMutedChange,
  onPushToTalkChange,
  onTalkingChange,
  onSendText,
  formatCountdown,
}: ExtendedControlsProps) {
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  // Global Space handling for push-to-talk. Bound while the session is live and the mode is on, so
  // it never swallows Space in a text field the rest of the time.
  useEffect(() => {
    if (!active || !pushToTalk) return;

    const isTyping = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || isTyping(event.target)) return;
      event.preventDefault();
      onTalkingChange(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isTyping(event.target)) return;
      event.preventDefault();
      onTalkingChange(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    // Losing focus (tab switched, window blurred) while held would otherwise leave the mic open.
    const onBlur = () => onTalkingChange(false);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [active, pushToTalk, onTalkingChange]);

  const transcriptText = useCallback(() => {
    const lines: string[] = [];
    for (const entry of transcript) {
      const who = entry.role === "user" ? "You" : "Assistant";
      const suffix = entry.interrupted ? " (interrupted)" : "";
      lines.push(`${who}${suffix}: ${entry.text}`);
    }
    return lines.join("\n");
  }, [transcript]);

  const copyTranscript = useCallback(async () => {
    const text = transcriptText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the download button remains available.
    }
  }, [transcriptText]);

  const downloadTranscript = useCallback(() => {
    const text = transcriptText();
    if (!text) return;
    // Blob rather than a data: URL, which browsers cap at a few MB and log a warning for.
    const blob = new Blob([`Voice conversation transcript\n\n${text}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `transcript-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }, [transcriptText]);

  const submitText = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = draft.trim();
      if (!trimmed) return;
      // A failed send means no live session; keep the text so it is not silently lost.
      if (onSendText(trimmed)) setDraft("");
    },
    [draft, onSendText],
  );

  const hasTranscript = transcript.length > 0;

  return (
    <section className="extended-controls" aria-label="Conversation controls">
      <div className="control-row">
        <button
          type="button"
          className="toggle-button"
          onClick={() => onMutedChange(!muted)}
          disabled={!active}
          aria-pressed={muted}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          title={muted ? "Unmute microphone" : "Mute microphone"}
        >
          {muted ? "Unmute" : "Mute"}
        </button>

        <button
          type="button"
          className="toggle-button"
          onClick={() => onPushToTalkChange(!pushToTalk)}
          disabled={!active}
          aria-pressed={pushToTalk}
          aria-label={pushToTalk ? "Turn off push to talk" : "Turn on push to talk"}
          title={pushToTalk ? "Push to talk: hold Space to speak" : "Turn on push to talk"}
        >
          Push to talk
        </button>

        {pushToTalk && (
          <button
            type="button"
            className={`talk-button ${talking ? "talk-button-live" : ""}`}
            onPointerDown={() => onTalkingChange(true)}
            onPointerUp={() => onTalkingChange(false)}
            onPointerLeave={() => onTalkingChange(false)}
            onKeyDown={(event) => {
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                onTalkingChange(true);
              }
            }}
            onKeyUp={(event) => {
              if (event.key === " " || event.key === "Enter") onTalkingChange(false);
            }}
            onBlur={() => onTalkingChange(false)}
            aria-pressed={talking}
            aria-label={talking ? "Microphone is open, release to close" : "Hold to speak"}
          >
            {talking ? "Listening…" : "Hold to speak"}
          </button>
        )}
      </div>

      {active && (devices.inputs.length > 1 || devices.outputs.length > 1 || devices.canSelectOutput) && (
        <div className="control-row">
          {devices.inputs.length > 0 && (
            <div className="field">
              <label className="field-label" htmlFor="mic-device">
                Microphone
              </label>
              <select
                id="mic-device"
                className="settings-select"
                value={devices.selectedInputId}
                onChange={(event) => devices.selectInput(event.target.value)}
              >
                {devices.inputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {devices.canSelectOutput && devices.outputs.length > 0 && (
            <div className="field">
              <label className="field-label" htmlFor="speaker-device">
                Speaker
              </label>
              <select
                id="speaker-device"
                className="settings-select"
                value={devices.selectedOutputId}
                onChange={(event) => void devices.selectOutput(event.target.value)}
              >
                {devices.outputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      <form className="control-row" onSubmit={submitText}>
        <div className="field grow">
          <label className="field-label" htmlFor="text-turn">
            Type instead of speaking
          </label>
          <input
            id="text-turn"
            className="text-input"
            value={draft}
            placeholder={active ? "Type a message" : "Start a conversation first"}
            disabled={!active}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <button type="submit" className="toggle-button" disabled={!active || draft.trim().length === 0} aria-label="Send typed message">
          Send
        </button>
      </form>

      <div className="control-row">
        <button
          type="button"
          className="text-button"
          onClick={() => void copyTranscript()}
          disabled={!hasTranscript}
          aria-label="Copy transcript to clipboard"
        >
          {copied ? "Copied" : "Copy transcript"}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={downloadTranscript}
          disabled={!hasTranscript}
          aria-label="Download transcript as a text file"
        >
          Download .txt
        </button>

        {remainingMs !== null && active && (
          <span className="countdown" role="status" aria-live="polite">
            {formatCountdown(remainingMs)} left
          </span>
        )}
      </div>

      {idleWarning && active && (
        <p className="warning-note" role="status" aria-live="polite">
          Still there? This conversation will end soon because nothing has been said.
        </p>
      )}
    </section>
  );
}