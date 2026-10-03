"use client";

import { useCallback, useEffect, useState } from "react";
import { VoiceOrb } from "./VoiceOrb";
import { VoiceStatus, TurnIndicator } from "./VoiceStatus";
import { VoiceControls } from "./VoiceControls";
import {
  DeviceSelectors,
  SessionNotices,
  SessionToolbar,
  TextComposer,
  TranscriptActions,
} from "./ExtendedControls";
import { AudioUnlockPrompt } from "./AudioUnlockPrompt";
import { VoiceTranscript } from "./VoiceTranscript";
import { VoiceSettings } from "./VoiceSettings";
import { UsagePanel } from "./UsagePanel";
import { SignOutButton } from "./SignOutButton";
import { DEFAULT_LANGUAGE_ID, DEFAULT_PERSONA_ID } from "@/lib/voice/config";
import { useMediaDevices } from "@/lib/voice/use-media-devices";
import { formatCountdown } from "@/lib/voice/use-session-limits";
import { useVoiceSession } from "@/lib/voice/use-voice-session";

/**
 * The voice conversation screen.
 *
 * Two panes. The stage is the live instrument: the ring, whose turn it is, what the assistant is
 * doing, the one button that matters, and the session controls. The conversation pane is the record,
 * always open, because reading back what was said is half the product. On a phone they stack.
 *
 * Owns nothing but layout and the settings chosen before a session exists: all conversation
 * behaviour comes from `useVoiceSession`.
 *
 * The control pieces are composed here rather than rendering `ExtendedControls`, because the composer
 * belongs at the foot of the conversation pane and the copy/download actions in its header. Rendering
 * the whole set as well would duplicate both.
 */
export function VoiceAgentScreen({ authRequired = false }: { authRequired?: boolean }) {
  // Settings live here rather than in the hook because they are chosen before a session exists.
  const [personaId, setPersonaId] = useState(DEFAULT_PERSONA_ID);
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE_ID);
  const [voice, setVoice] = useState("marin");

  const session = useVoiceSession({ personaId, language, voice });
  const {
    state,
    turnOwner,
    isActive,
    error,
    capabilities,
    transcript,
    micLevel,
    assistantLevel,
    toolRunning,
    muted,
    pushToTalk,
    talking,
    remainingMs,
    idleWarning,
    usage,
    needsAudioUnlock,
    unlockAudio,
    setMuted,
    setPushToTalk,
    setTalking,
    sendText,
    start,
    stop,
  } = session;

  const devices = useMediaDevices();
  const [starting, setStarting] = useState(false);

  /**
   * Capability detection reads browser APIs that do not exist while the page is being rendered on
   * the server, so it reports "unsupported" there and "supported" once React hydrates. Rendering
   * that difference straight into the markup produced a hydration mismatch: the server emitted a
   * disabled primary button and an "unsupported" hint that the client immediately threw away.
   *
   * Gating on `mounted` makes the first client render agree with the server, and the capability
   * result lands a frame later — long before anyone could press the button.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const unsupported = mounted && !capabilities.supported;

  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      await start();
    } finally {
      setStarting(false);
    }
  }, [start]);

  // Device labels only appear after a permission grant, so the list is refreshed once the
  // microphone is actually open rather than on mount.
  const [wasActive, setWasActive] = useState(false);
  if (wasActive !== isActive) {
    setWasActive(isActive);
    if (isActive) void devices.refresh();
  }

  return (
    <main className="app">
      <div className="stage">
        <header className="stage-header">
          <h1 className="brand">Realtime Voice Agent</h1>
          <p className="tagline">A live, interruptible conversation. Just talk.</p>
        </header>

        <div className="ring-area">
          <VoiceOrb state={state} micLevel={micLevel} assistantLevel={assistantLevel} active={isActive} />
          <TurnIndicator turnOwner={isActive ? turnOwner : "none"} />
        </div>

        <AudioUnlockPrompt visible={needsAudioUnlock && isActive} onUnlock={unlockAudio} />

        <VoiceStatus state={state} error={error} toolRunning={toolRunning} active={isActive} />

        <VoiceControls
          active={isActive}
          state={state}
          busy={starting || state === "connecting" || state === "reconnecting"}
          disabled={unsupported}
          disabledReason={
            unsupported ? "This browser isn't supported. Try the latest Chrome, Edge, or Safari." : undefined
          }
          onStart={handleStart}
          onEnd={stop}
        />

        {isActive && (
          <div className="controls-stack">
            <SessionToolbar
              active={isActive}
              muted={muted}
              pushToTalk={pushToTalk}
              talking={talking}
              onMutedChange={setMuted}
              onPushToTalkChange={setPushToTalk}
              onTalkingChange={setTalking}
            />

            <DeviceSelectors active={isActive} devices={devices} />

            <SessionNotices
              active={isActive}
              remainingMs={remainingMs}
              idleWarning={idleWarning}
              formatCountdown={formatCountdown}
            />
          </div>
        )}

        <VoiceSettings
          personaId={personaId}
          language={language}
          voice={voice}
          disabled={isActive}
          onPersonaChange={setPersonaId}
          onLanguageChange={setLanguage}
          onVoiceChange={setVoice}
        />

        {unsupported && (
          <p className="capability-note" role="status">
            Missing: {capabilities.missing.join(", ")}.
          </p>
        )}

        <UsagePanel usage={usage} />

        {authRequired && <SignOutButton />}
      </div>

      <VoiceTranscript
        entries={transcript}
        agentName="Assistant"
        actions={<TranscriptActions transcript={transcript} />}
        composer={<TextComposer active={isActive} onSendText={sendText} />}
      />
    </main>
  );
}