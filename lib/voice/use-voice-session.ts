"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  openaiRealtime,
  runVoiceAgent,
  stopMediaStream,
  type VoiceAgentEvent,
  type VoiceSession,
} from "samai-sdk/voice";
import { createVoiceAgent, turnDetection } from "./agent";
import type {
  SessionResponseBody,
  TranscriptEntry,
  TurnOwner,
  VoiceCapabilities,
  VoiceError,
  VoiceErrorKind,
  VoiceState,
} from "./types";

/**
 * Drives one live realtime voice conversation.
 *
 * Orchestration belongs to SamAI SDK: `openaiRealtime()` owns the transport and feeds a
 * `ConversationEngine` state machine, and `runVoiceAgent()` subscribes to the SDK's ordered event
 * stream. This hook owns only what the SDK deliberately leaves to the application — microphone
 * permission, playback, transcript bookkeeping, reconnect, and teardown.
 */

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 800;
const MICROPHONE_NOISE_FLOOR = 0.02;

let entryCounter = 0;
function nextEntryId(): string {
  entryCounter += 1;
  return `entry-${entryCounter}`;
}

export function detectCapabilities(): VoiceCapabilities {
  if (typeof window === "undefined") {
    return { supported: false, getUserMedia: false, webRTC: false, audioContext: false, missing: ["server rendering"] };
  }
  const missing: string[] = [];
  const getUserMedia = !!navigator.mediaDevices?.getUserMedia;
  const webRTC = typeof RTCPeerConnection !== "undefined";
  const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!getUserMedia) missing.push("microphone capture is unavailable");
  if (!webRTC) missing.push("WebRTC is unavailable");
  if (!AudioCtor) missing.push("Web Audio is unavailable");
  return { supported: missing.length === 0, getUserMedia, webRTC, audioContext: !!AudioCtor, missing };
}

/** Maps any thrown value onto a user-facing error. Raw exceptions never reach the UI. */
export function toVoiceError(err: unknown): VoiceError {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const name = err instanceof Error ? err.name : "";
  const haystack = `${name} ${raw}`.toLowerCase();

  const rules: Array<[RegExp, VoiceErrorKind, string, boolean]> = [
    [/notallowed|permission denied|permission_denied/, "permission_denied", "Microphone access is required to start a voice conversation.", true],
    [/notfound|devicesnotfound|no microphone/, "microphone_unavailable", "No microphone was found on this device.", false],
    [/notreadable|track (start|ended)|audio_capture_failed/, "audio_capture_failed", "The microphone stopped responding. Check that it is still connected.", true],
    [/webrtc is not available|not support|unsupported/, "unsupported_browser", "This browser does not support the audio features this app needs. Try the latest Chrome, Edge, or Safari.", false],
    [/auth_failed|401|403|unauthor|api key/, "auth_failed", "The server could not authenticate with OpenAI. Check the OPENAI_API_KEY setting.", false],
    [/rate_limited|429|rate limit|too many requests/, "rate_limited", "OpenAI is rate limiting this account. Try again in a moment.", true],
    [/model_unavailable|\bmodel\b/, "model_unavailable", "The configured realtime model is not available for this API key.", false],
    [/connection_failed|network|failed to fetch|\bice\b|websocket/, "connection_failed", "Lost the connection to the voice service.", true],
    [/session/, "session_failed", "Could not start a realtime session. Please try again.", true],
  ];

  for (const [pattern, kind, message, retryable] of rules) {
    if (pattern.test(haystack)) return { kind, message, retryable };
  }
  return { kind: "unknown", message: "Something went wrong with the voice session. Please try again.", retryable: true };
}

/** A smoothed 0–1 amplitude meter driven by a real `AnalyserNode`. */
interface LevelMeter {
  read(): number;
  dispose(): void;
}

export interface UseVoiceSessionResult {
  state: VoiceState;
  turnOwner: TurnOwner;
  isActive: boolean;
  error: VoiceError | null;
  capabilities: VoiceCapabilities;
  transcript: TranscriptEntry[];
  /** Sample inside an animation frame, not during render. 0–1. */
  micLevel(): number;
  /** Sample inside an animation frame, not during render. 0–1. */
  assistantLevel(): number;
  /** True while a tool call is executing. */
  toolRunning: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function useVoiceSession(): UseVoiceSessionResult {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<VoiceError | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [toolRunning, setToolRunning] = useState(false);
  const [isActive, setIsActive] = useState(false);

  const capabilitiesRef = useRef<VoiceCapabilities | null>(null);
  if (capabilitiesRef.current === null) capabilitiesRef.current = detectCapabilities();

  // Audio plumbing and teardown must not depend on React render timing, so all of it lives in refs.
  const sessionRef = useRef<VoiceSession | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const micMeterRef = useRef<LevelMeter | null>(null);
  const assistantMeterRef = useRef<LevelMeter | null>(null);
  const meterContextRef = useRef<AudioContext | null>(null);
  const activeRef = useRef(false);
  /**
   * Whether the assistant currently holds the turn.
   *
   * Deliberately not derived from React state: a burst of realtime events can arrive inside a single
   * batch, and an effect-synced mirror would still hold the previous value when the barge-in check
   * runs. This ref is written synchronously as events are handled.
   */
  const assistantSpeakingRef = useRef(false);

  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  /** Reconnect is referenced from the event handler, which is created before it. A ref breaks the cycle. */
  const reconnectRef = useRef<() => void>(() => {});
  /** Streaming transcript entry id per role. */
  const streamingRef = useRef<{ user?: string; assistant?: string }>({});

  // ── transcript bookkeeping ────────────────────────────────────────────────

  const finalizeAssistant = useCallback((interrupted: boolean) => {
    const id = streamingRef.current.assistant;
    streamingRef.current.assistant = undefined;
    if (!id) return;
    setTranscript((prev) =>
      prev.map((entry) =>
        entry.id === id
          ? { ...entry, status: interrupted ? "interrupted" : "final", interrupted: interrupted || undefined, text: entry.text.trimEnd() }
          : entry,
      ),
    );
  }, []);

  const finalizeUser = useCallback(() => {
    const id = streamingRef.current.user;
    streamingRef.current.user = undefined;
    if (!id) return;
    setTranscript((prev) => prev.map((entry) => (entry.id === id ? { ...entry, status: "final", text: entry.text.trim() } : entry)));
  }, []);

  // ── audio plumbing ────────────────────────────────────────────────────────

  const ensureAudioContext = useCallback((): AudioContext | null => {
    let context = meterContextRef.current;
    if (context && context.state !== "closed") {
      if (context.state === "suspended") void context.resume();
      return context;
    }
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    meterContextRef.current = context;
    // Browsers require a user gesture; `start()` is always called from a click, but this can run
    // after an await, so resume defensively.
    if (context.state === "suspended") void context.resume();
    return context;
  }, []);

  /**
   * Builds an amplitude meter for a stream. The analyser is intentionally never connected to the
   * destination: routing microphone audio back to the speakers would create a feedback loop, and
   * WebRTC's echo cancellation needs to keep owning that path.
   */
  const attachMeter = useCallback((context: AudioContext, stream: MediaStream, smoothing: number): LevelMeter => {
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = smoothing;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Uint8Array(analyser.fftSize);
    let level = 0;
    let frame: number | null = null;

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const centred = (data[i] - 128) / 128;
        sum += centred * centred;
      }
      const rms = Math.sqrt(sum / data.length);
      const next = rms <= MICROPHONE_NOISE_FLOOR ? 0 : Math.min(1, (rms - MICROPHONE_NOISE_FLOOR) / (1 - MICROPHONE_NOISE_FLOOR));
      // Fast attack, slow release: speech registers instantly, then decays gently.
      level = next > level ? next : level * 0.88 + next * 0.12;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return {
      read: () => level,
      dispose: () => {
        if (frame !== null) cancelAnimationFrame(frame);
        try {
          source.disconnect();
        } catch {}
        try {
          analyser.disconnect();
        } catch {}
      },
    };
  }, []);

  // ── SDK event stream ──────────────────────────────────────────────────────

  const handleEvent = useCallback(
    (event: VoiceAgentEvent) => {
      switch (event.type) {
        case "connection-state": {
          switch (event.state) {
            case "connected":
              reconnectAttemptRef.current = 0;
              setError(null);
              setState("listening");
              break;
            case "connecting":
              setState("connecting");
              break;
            case "reconnecting":
              setState("reconnecting");
              break;
            case "failed":
              // A live conversation that dropped should try to come back on its own.
              if (activeRef.current) reconnectRef.current();
              else {
                setError({ kind: "connection_failed", message: "Lost the connection to the voice service.", retryable: true });
                setState("error");
              }
              break;
            case "closed":
              if (!activeRef.current) setState("idle");
              break;
          }
          break;
        }

        case "user-speech-started":
          // Barge-in. OpenAI has already cancelled the response server-side and dropped the audio
          // the user never heard; here we only record that the transcript must show it as cut off.
          if (assistantSpeakingRef.current) {
            assistantSpeakingRef.current = false;
            finalizeAssistant(true);
          }
          setState("user_speaking");
          break;

        case "user-transcript-delta": {
          if (!event.delta) {
            // Empty delta marks the start of a new turn.
            const id = nextEntryId();
            streamingRef.current.user = id;
            setTranscript((prev) => [...prev, { id, role: "user", text: "", status: "streaming", startedAt: Date.now() }]);
            break;
          }
          const id = (streamingRef.current.user ??= nextEntryId());
          setTranscript((prev) =>
            prev.some((entry) => entry.id === id)
              ? prev.map((entry) => (entry.id === id ? { ...entry, text: entry.text + event.delta } : entry))
              : [...prev, { id, role: "user", text: event.delta, status: "streaming", startedAt: Date.now() }],
          );
          break;
        }

        case "user-speech-ended":
          finalizeUser();
          setState("thinking");
          break;

        case "assistant-transcript-delta": {
          const id = (streamingRef.current.assistant ??= nextEntryId());
          setTranscript((prev) =>
            prev.some((entry) => entry.id === id)
              ? prev.map((entry) => (entry.id === id ? { ...entry, text: entry.text + event.delta } : entry))
              : [...prev, { id, role: "assistant", text: event.delta, status: "streaming", startedAt: Date.now() }],
          );
          break;
        }

        case "assistant-transcript-done":
          finalizeAssistant(false);
          break;

        case "response-cancelled":
          assistantSpeakingRef.current = false;
          finalizeAssistant(true);
          break;

        case "agent-speech-started":
          assistantSpeakingRef.current = true;
          setState("assistant_speaking");
          break;

        case "agent-speech-ended":
          assistantSpeakingRef.current = false;
          setState((prev) => (prev === "assistant_speaking" || prev === "interrupting" ? "listening" : prev));
          break;

        case "agent-thinking":
          setState((prev) => (prev === "assistant_speaking" ? prev : "thinking"));
          break;

        case "interruption":
          setState("interrupting");
          break;

        case "tool-started":
          setToolRunning(true);
          break;

        case "tool-completed":
        case "run-completed":
          setToolRunning(false);
          break;

        case "run-failed":
          setToolRunning(false);
          setError(toVoiceError(event.error));
          break;

        default:
          break;
      }
    },
    [finalizeAssistant, finalizeUser],
  );

  // ── teardown ──────────────────────────────────────────────────────────────

  const releaseAudio = useCallback(() => {
    micMeterRef.current?.dispose();
    micMeterRef.current = null;
    assistantMeterRef.current?.dispose();
    assistantMeterRef.current = null;

    const el = audioElRef.current;
    if (el) {
      el.pause();
      el.srcObject = null;
    }
    audioElRef.current = null;

    stopMediaStream(micStreamRef.current);
    micStreamRef.current = null;

    const context = meterContextRef.current;
    meterContextRef.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }, []);

  const releaseSession = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      try {
        await session.close();
      } catch {
        // A session that has already dropped is fine to discard.
      }
    }
  }, []);

  const cancelReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // ── connect ───────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    const caps = capabilitiesRef.current!;
    if (!caps.supported) {
      setError({
        kind: "unsupported_browser",
        message: `This browser can't run a voice conversation: ${caps.missing.join(", ")}.`,
        retryable: false,
      });
      setState("error");
      return;
    }

    setState("connecting");
    setError(null);

    // 1. Microphone — requested only when the user starts a conversation, never on page load.
    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      setError(toVoiceError(err));
      setState("error");
      return;
    }
    micStreamRef.current = micStream;

    // 2. Ephemeral credential from our own server. The long-lived key never leaves the server.
    let sessionInfo: SessionResponseBody;
    try {
      const res = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: VoiceErrorKind; message?: string } | null;
        throw new Error(body?.message ?? `Request failed with status ${res.status}`);
      }
      sessionInfo = (await res.json()) as SessionResponseBody;
    } catch (err) {
      releaseAudio();
      setError(toVoiceError(err));
      setState("error");
      return;
    }

    const agent = createVoiceAgent(sessionInfo.model, sessionInfo.voice);
    const context = ensureAudioContext();

    // 3. Playback element first: the provider may hand us the remote stream while connecting, and
    // the callback below needs somewhere to attach it.
    if (!audioElRef.current) {
      const el = new Audio();
      el.setAttribute("playsinline", "true");
      audioElRef.current = el;
    }
    const audioEl = audioElRef.current;

    try {
      // 4. Realtime session over WebRTC, orchestrated by the SamAI SDK.
      const provider = openaiRealtime({
        transport: "webrtc",
        clientSecret: sessionInfo.clientSecret,
        model: sessionInfo.model,
        voice: sessionInfo.voice,
        inputStream: micStream,
        turnDetection,
        onRemoteStream: (remoteStream) => {
          audioEl.srcObject = remoteStream;
          audioEl.autoplay = true;
          void audioEl.play().catch(() => {
            // Usually the Start click already unlocked playback; a rejection here is not fatal.
          });
          if (context) assistantMeterRef.current = attachMeter(context, remoteStream, 0.7);
        },
      });

      const { session } = await runVoiceAgent(provider, agent, { onEvent: handleEvent });

      if (!activeRef.current) {
        // The user ended the conversation while this was still connecting.
        await session.close();
        return;
      }
      sessionRef.current = session;

      // 5. Meter the microphone so the interface can show that the user is talking.
      if (context) micMeterRef.current = attachMeter(context, micStream, 0.6);
    } catch (err) {
      releaseAudio();
      await releaseSession();
      if (activeRef.current) {
        // This was a reconnect attempt. Report the failure, then let the backoff loop decide whether
        // to try again or give up — otherwise one failed attempt would end the conversation.
        setError(toVoiceError(err));
        reconnectRef.current();
        return;
      }
      setError(toVoiceError(err));
      setState("error");
    }
  }, [attachMeter, ensureAudioContext, handleEvent, releaseAudio, releaseSession]);

  /** Re-establishes the session after a drop, with bounded exponential backoff. */
  const scheduleReconnect = useCallback(() => {
    if (!activeRef.current) return;
    const attempt = reconnectAttemptRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setError({
        kind: "connection_failed",
        message: `Lost the connection and could not reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts.`,
        retryable: true,
      });
      setState("error");
      return;
    }

    reconnectAttemptRef.current = attempt + 1;
    setState("reconnecting");

    reconnectTimerRef.current = setTimeout(async () => {
      reconnectTimerRef.current = null;
      if (!activeRef.current) return;
      // A fresh ephemeral secret is required: the previous one may have expired mid-conversation.
      await releaseSession();
      releaseAudio();
      await connect();
    }, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
  }, [connect, releaseAudio, releaseSession]);

  reconnectRef.current = scheduleReconnect;

  const start = useCallback(async () => {
    // Guard against a double click (or a second call racing the first): starting twice would leave an
    // orphaned realtime session and microphone behind.
    if (activeRef.current) return;
    cancelReconnect();
    activeRef.current = true;
    reconnectAttemptRef.current = 0;
    setIsActive(true);
    setTranscript([]);
    streamingRef.current = {};
    setToolRunning(false);
    setState("connecting");
    await connect();
  }, [cancelReconnect, connect]);

  const stop = useCallback(async () => {
    activeRef.current = false;
    assistantSpeakingRef.current = false;
    setIsActive(false);
    cancelReconnect();
    await releaseSession();
    releaseAudio();
    streamingRef.current = {};
    setToolRunning(false);
    setError(null);
    setState("idle");
  }, [cancelReconnect, releaseAudio, releaseSession]);

  // ── unmount ────────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      activeRef.current = false;
      cancelReconnect();
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) void session.close().catch(() => {});
      micMeterRef.current?.dispose();
      assistantMeterRef.current?.dispose();
      stopMediaStream(micStreamRef.current);
      micStreamRef.current = null;
      const el = audioElRef.current;
      if (el) {
        el.pause();
        el.srcObject = null;
      }
      audioElRef.current = null;
      const context = meterContextRef.current;
      if (context && context.state !== "closed") void context.close().catch(() => {});
    };
  }, [cancelReconnect]);

  return {
    state,
    turnOwner: state === "user_speaking" ? "user" : state === "assistant_speaking" ? "assistant" : "none",
    isActive,
    error,
    capabilities: capabilitiesRef.current!,
    transcript,
    micLevel: () => micMeterRef.current?.read() ?? 0,
    assistantLevel: () => assistantMeterRef.current?.read() ?? 0,
    toolRunning,
    start,
    stop,
  };
}