"use client";

import { useCallback, useState } from "react";
import { VoiceOrb } from "./VoiceOrb";
import { VoiceVisualizer } from "./VoiceVisualizer";
import { VoiceStatus } from "./VoiceStatus";
import { VoiceControls } from "./VoiceControls";
import { VoiceTranscript } from "./VoiceTranscript";
import { VoiceSettings } from "./VoiceSettings";
import { DEFAULT_LANGUAGE_ID, DEFAULT_PERSONA_ID } from "@/lib/voice/config";
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

  const { state, turnOwner, isActive, error, capabilities, transcript, micLevel, assistantLevel, toolRunning, start, stop } =
    useVoiceSession({ personaId, language, voice });

  const [starting, setStarting] = useState(false);

  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      await start();
    } finally {
      setStarting(false);
    }
  }, [start]);

  return (
    <main className="shell">
      <div className="stage">
        <header className="stage-header">
          <h1 className="brand">SamAI Voice</h1>
          <p className="tagline">A live, interruptible conversation. Just talk.</p>
        </header>

        <div className="orb-area">
          <VoiceOrb state={state} micLevel={micLevel} assistantLevel={assistantLevel} active={isActive} />
        </div>

        <VoiceVisualizer level={turnOwner === "assistant" ? assistantLevel : micLevel} active={isActive} />

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
      </div>
    </main>
  );
}