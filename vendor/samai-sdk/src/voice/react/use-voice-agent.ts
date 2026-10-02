import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceAgentConfig, VoiceProvider, VoiceSession } from "../types.js";

export interface UseVoiceAgentState {
  isConnected: boolean;
  isSpeaking: boolean;
  isListening: boolean;
  transcript: string;
  error: Error | null;
}

export interface UseVoiceAgentResult extends UseVoiceAgentState {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendAudio(chunk: ArrayBuffer): void;
  interrupt(): void;
}

/**
 * Drives a voice agent session from a React component.
 * Mirrors src/react.ts useAgent hook pattern: state via useState,
 * session via useRef, methods via useCallback, subscriptions via VoiceSession.on.
 *
 * Usage:
 *   const { isConnected, isSpeaking, transcript, connect, disconnect, sendAudio, interrupt } = useVoiceAgent(provider, agent);
 */
export function useVoiceAgent(provider: VoiceProvider, agent: VoiceAgentConfig): UseVoiceAgentResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<Error | null>(null);

  const sessionRef = useRef<VoiceSession | null>(null);
  const unsubsRef = useRef<(() => void)[]>([]);

  const cleanupSubscriptions = useCallback(() => {
    for (const unsub of unsubsRef.current) {
      try {
        unsub();
      } catch {}
    }
    unsubsRef.current = [];
  }, []);

  const connect = useCallback(async () => {
    if (sessionRef.current) return;
    setError(null);
    try {
      const session = await provider.connect({ agent });
      sessionRef.current = session;
      setIsConnected(true);

      unsubsRef.current.push(session.on("user-speech-started", () => setIsListening(true)));
      unsubsRef.current.push(
        session.on("user-speech-ended", (e) => {
          setIsListening(false);
          setTranscript(e.transcript);
        })
      );
      unsubsRef.current.push(session.on("agent-speech-started", () => setIsSpeaking(true)));
      unsubsRef.current.push(session.on("agent-speech-ended", () => setIsSpeaking(false)));
      unsubsRef.current.push(session.on("agent-thinking", () => setIsSpeaking(false)));
      unsubsRef.current.push(session.on("interruption", () => setIsSpeaking(false)));
      unsubsRef.current.push(
        session.on("run-failed", (e) => {
          setError(e.error);
          setIsConnected(false);
          setIsSpeaking(false);
          setIsListening(false);
        })
      );
      unsubsRef.current.push(session.on("run-completed", () => setIsSpeaking(false)));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      setIsConnected(false);
    }
  }, [provider, agent]);

  const disconnect = useCallback(async () => {
    cleanupSubscriptions();
    const s = sessionRef.current;
    sessionRef.current = null;
    if (s) {
      try {
        await s.close();
      } catch {}
    }
    setIsConnected(false);
    setIsSpeaking(false);
    setIsListening(false);
  }, [cleanupSubscriptions]);

  const sendAudio = useCallback((chunk: ArrayBuffer) => {
    sessionRef.current?.sendAudio(chunk);
  }, []);

  const interrupt = useCallback(() => {
    sessionRef.current?.interrupt();
    setIsSpeaking(false);
  }, []);

  useEffect(() => {
    return () => {
      cleanupSubscriptions();
      const s = sessionRef.current;
      if (s) {
        void s.close().catch(() => {});
      }
      sessionRef.current = null;
    };
  }, [cleanupSubscriptions]);

  return {
    isConnected,
    isSpeaking,
    isListening,
    transcript,
    error,
    connect,
    disconnect,
    sendAudio,
    interrupt,
  };
}
