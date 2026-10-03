"use client";

import { useCallback, useEffect, useState } from "react";
import type { TranscriptEntry } from "@/lib/voice/types";
import type { MediaDevicesResult } from "@/lib/voice/use-media-devices";
import { CheckIcon, CopyIcon, DownloadIcon, MicIcon, MicOffIcon, PushToTalkIcon, SendIcon } from "./icons";

/**
 * Controls for a live session.
 *
 * Split into pieces so the screen can place each one where it belongs — the composer belongs in the
 * conversation pane, the device pickers in the stage — while `ExtendedControls` below still composes
 * the lot, because it is the unit the tests drive.
 *
 * Every control is a real focusable element with an accessible name, so the whole panel is usable
 * from the keyboard.
 */

/**
 * Binds Space to push-to-talk while the mode is on and a session is live.
 *
 * Global rather than scoped to the button because holding a key with the pointer already occupies
 * the hand. Typed into a text field it is left alone, or the user could not write a space.
 */
export function usePushToTalkKeys(enabled: boolean, onTalkingChange: (talking: boolean) => void) {
  useEffect(() => {
    if (!enabled) return;

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
  }, [enabled, onTalkingChange]);
}

/** Plain-text export of the conversation. Shared by copy and download so they cannot diverge. */
export function transcriptToText(transcript: TranscriptEntry[]): string {
  const lines: string[] = [];
  for (const entry of transcript) {
    const who = entry.role === "user" ? "You" : "Assistant";
    const suffix = entry.interrupted ? " (interrupted)" : "";
    lines.push(`${who}${suffix}: ${entry.text}`);
  }
  return lines.join("\n");
}

export interface SessionToolbarProps {
  active: boolean;
  muted: boolean;
  pushToTalk: boolean;
  talking: boolean;
  onMutedChange(muted: boolean): void;
  onPushToTalkChange(enabled: boolean): void;
  onTalkingChange(talking: boolean): void;
}

/** Mute, push-to-talk, and the hold-to-speak button that push-to-talk reveals. */
export function SessionToolbar({
  active,
  muted,
  pushToTalk,
  talking,
  onMutedChange,
  onPushToTalkChange,
  onTalkingChange,
}: SessionToolbarProps) {
  usePushToTalkKeys(active && pushToTalk, onTalkingChange);

  return (
    <div className="control-row">
      <button
        type="button"
        className="chip"
        onClick={() => onMutedChange(!muted)}
        disabled={!active}
        aria-pressed={muted}
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
        title={muted ? "Unmute microphone" : "Mute microphone"}
      >
        {muted ? <MicOffIcon /> : <MicIcon />}
        {muted ? "Unmute" : "Mute"}
      </button>

      <button
        type="button"
        className="chip"
        onClick={() => onPushToTalkChange(!pushToTalk)}
        disabled={!active}
        aria-pressed={pushToTalk}
        aria-label={pushToTalk ? "Turn off push to talk" : "Turn on push to talk"}
        title={pushToTalk ? "Push to talk: hold Space to speak" : "Turn on push to talk"}
      >
        <PushToTalkIcon />
        Push to talk
      </button>

      {pushToTalk && (
        <button
          type="button"
          className={`chip hold-button ${talking ? "chip-live" : ""}`}
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
  );
}

export interface DeviceSelectorsProps {
  active: boolean;
  devices: MediaDevicesResult;
}

/**
 * Microphone and speaker pickers.
 *
 * Hidden unless there is a real choice to make: one input device and an unsupported output switch
 * means there is nothing here to decide, and an empty panel is noise.
 */
export function DeviceSelectors({ active, devices }: DeviceSelectorsProps) {
  const hasChoice = devices.inputs.length > 1 || devices.outputs.length > 1 || devices.canSelectOutput;
  if (!active || !hasChoice) return null;

  return (
    <div className="control-row">
      {devices.inputs.length > 0 && (
        <div className="field grow">
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
        <div className="field grow">
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
  );
}

export interface TextComposerProps {
  active: boolean;
  onSendText(text: string): boolean;
}

/** A typed turn, for when speaking is not practical or the microphone is not wanted. */
export function TextComposer({ active, onSendText }: TextComposerProps) {
  const [draft, setDraft] = useState("");

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = draft.trim();
      if (!trimmed) return;
      // A failed send means no live session; keep the text so it is not silently lost.
      if (onSendText(trimmed)) setDraft("");
    },
    [draft, onSendText],
  );

  return (
    <form className="composer" onSubmit={submit}>
      <div className="field grow">
        {/* Visually hidden, but a real label: the placeholder disappears as soon as there is text,
            which would leave the field unlabelled for anyone using a screen reader. */}
        <label className="visually-hidden" htmlFor="text-turn">
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
      <button
        type="submit"
        className="composer-button"
        disabled={!active || draft.trim().length === 0}
        aria-label="Send typed message"
      >
        <SendIcon />
        Send
      </button>
    </form>
  );
}

export interface TranscriptActionsProps {
  transcript: TranscriptEntry[];
}

/** Copy and download. Download stays available when the clipboard is denied. */
export function TranscriptActions({ transcript }: TranscriptActionsProps) {
  const [copied, setCopied] = useState(false);
  const hasTranscript = transcript.length > 0;

  const copy = useCallback(async () => {
    const text = transcriptToText(transcript);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the download button remains available.
    }
  }, [transcript]);

  const download = useCallback(() => {
    const text = transcriptToText(transcript);
    if (!text) return;
    // Blob rather than a data: URL, which browsers cap at a few MB and log a warning for.
    const blob = new Blob([`Voice conversation transcript\n\n${text}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `transcript-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }, [transcript]);

  return (
    <>
      <button
        type="button"
        className="text-button"
        onClick={() => void copy()}
        disabled={!hasTranscript}
        aria-label="Copy transcript to clipboard"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy transcript"}
      </button>
      <button
        type="button"
        className="text-button"
        onClick={download}
        disabled={!hasTranscript}
        aria-label="Download transcript as a text file"
      >
        <DownloadIcon />
        Download .txt
      </button>
    </>
  );
}

export interface SessionNoticesProps {
  active: boolean;
  remainingMs: number | null;
  idleWarning: boolean;
  formatCountdown(ms: number): string;
}

/**
 * The countdown and the idle warning.
 *
 * The warning was 0.8rem of muted text before, which is not how you tell someone their conversation
 * is about to be taken away from them. It is a notice with its own surface now.
 */
export function SessionNotices({ active, remainingMs, idleWarning, formatCountdown }: SessionNoticesProps) {
  const showCountdown = remainingMs !== null && active;
  const showWarning = idleWarning && active;
  if (!showCountdown && !showWarning) return null;

  return (
    <div className="notices">
      {showCountdown && (
        <p className="countdown" role="status" aria-live="polite">
          {formatCountdown(remainingMs!)} left
        </p>
      )}
      {showWarning && (
        <p className="notice notice-warning" role="status" aria-live="polite">
          Still there? This conversation will end soon because nothing has been said.
        </p>
      )}
    </div>
  );
}

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

/**
 * Every session control, composed into one region.
 *
 * The two-pane screen does not use this: it places `TextComposer` at the bottom of the conversation
 * pane and `TranscriptActions` in the conversation header, and composes the rest itself. Rendering
 * the whole set here as well would put a second copy of each control on screen. It stays as the
 * single-region composition because that is the unit the tests drive, and because it is the sane
 * fallback for a one-column layout.
 */
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
  return (
    <section className="extended-controls controls-stack" aria-label="Conversation controls">
      <SessionToolbar
        active={active}
        muted={muted}
        pushToTalk={pushToTalk}
        talking={talking}
        onMutedChange={onMutedChange}
        onPushToTalkChange={onPushToTalkChange}
        onTalkingChange={onTalkingChange}
      />

      <DeviceSelectors active={active} devices={devices} />

      <TextComposer active={active} onSendText={onSendText} />

      <div className="control-row">
        <TranscriptActions transcript={transcript} />
      </div>

      <SessionNotices active={active} remainingMs={remainingMs} idleWarning={idleWarning} formatCountdown={formatCountdown} />
    </section>
  );
}