"use client";

import { useCallback, useState } from "react";
import { VoiceOrb } from "./VoiceOrb";
import { VoiceVisualizer } from "./VoiceVisualizer";
import { VoiceStatus } from "./VoiceStatus";
import { VoiceControls } from "./VoiceControls";
import { ExtendedControls } from "./ExtendedControls";
import { AudioUnlockPrompt } from "./AudioUnlockPrompt";
import { VoiceTranscript } from "./VoiceTranscript";
import { VoiceSettings } from "./VoiceSettings";
import { UsagePanel } from "./UsagePanel";
import { DEFAULT_LANGUAGE_ID, DEFAULT_PERSONA_ID } from "@/lib/voice/config";
import { useMediaDevices } from "@/lib/voice/use-media-devices";
import { formatCountdown } from "@/lib/voice/use-session-limits";
import { useVoiceSession } from "@/lib/voice/use-voice-session";

/**
 * The voice conversation screen.
 *
 * Owns nothing but layout: all conversation behaviour comes from `useVoiceSession`, which drives the
 * realtime session.
 */
export function VoiceAgentScreen() {
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
  const handleSessionActive = useCallback(() => {
    void devices.refresh();
  }, [devices]);

  const [wasActive, setWasActive] = useState(false);
  if (wasActive !== isActive) {
    setWasActive(isActive);
    if (isActive) handleSessionActive();
  }

  return (
    <main className="shell">
      <div className="stage">
        <header className="stage-header">
          <h1 className="brand">Voice Agent</h1>
          <p className="tagline">A live, interruptible conversation. Just talk.</p>
        </header>

        <div className="orb-area">
          <VoiceOrb state={state} micLevel={micLevel} assistantLevel={assistantLevel} active={isActive} />
        </div>

        <VoiceVisualizer level={turnOwner === "assistant" ? assistantLevel : micLevel} active={isActive} />

        <AudioUnlockPrompt visible={needsAudioUnlock && isActive} onUnlock={unlockAudio} />

        <VoiceStatus state={state} error={error} toolRunning={toolRunning} active={isActive} />

        <VoiceControls
          active={isActive}
          state={state}
          busy={starting || state === "connecting" || state === "reconnecting"}
          disabled={!capabilities.supported}
          disabledReason={
            capabilities.supported ? undefined : "This browser isn't supported. Try the latest Chrome, Edge, or Safari."
          }
          onStart={handleStart}
          onEnd={stop}
        />

        <ExtendedControls
          active={isActive}
          muted={muted}
          pushToTalk={pushToTalk}
          talking={talking}
          transcript={transcript}
          devices={devices}
          remainingMs={remainingMs}
          idleWarning={idleWarning}
          onMutedChange={setMuted}
          onPushToTalkChange={setPushToTalk}
          onTalkingChange={setTalking}
          onSendText={sendText}
          formatCountdown={formatCountdown}
        />

        <VoiceTranscript entries={transcript} agentName="Assistant" />

        <VoiceSettings
          personaId={personaId}
          language={language}
          voice={voice}
          disabled={isActive}
          onPersonaChange={setPersonaId}
          onLanguageChange={setLanguage}
          onVoiceChange={setVoice}
        />

        {!capabilities.supported && (
          <p className="capability-note" role="status">
            Missing: {capabilities.missing.join(", ")}.
          </p>
        )}

        <UsagePanel usage={usage} />
      </div>
    </main>
  );
}