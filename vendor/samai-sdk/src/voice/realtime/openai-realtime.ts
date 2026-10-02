import type {
  VoiceProvider,
  VoiceConnectOptions,
  VoiceSession,
  VoiceAgentEvent,
  VoiceConnectionState,
} from "../types.js";
import type { RealtimeEvent, RealtimeSessionOptions, RealtimeTurnDetection } from "../../voice.js";
import { createRealtimeSession } from "../../voice.js";
import { ConversationEngine } from "../conversation-engine.js";
import { OpenAIRealtimeWebRTCTransport, type NegotiatedRealtimeCall } from "../transport/openai-webrtc.js";
import { toArrayBuffer } from "../../bytes.js";
import { toolParametersJsonSchema } from "../../schema-adapter.js";
import { createTrace, finishTrace, type RunTrace } from "../../trace.js";
import { randomUUID } from "../../uuid.js";

/**
 * Transport used to reach OpenAI's Realtime API.
 *
 * - `"webrtc"` (default when an input stream is supplied): the browser hands its microphone track
 *   to the API and plays the returned remote track. Lowest latency, and the API truncates
 *   interrupted assistant audio server-side so the model's memory matches what was played.
 * - `"websocket"`: base64 PCM over a socket. The right choice on a server, or where WebRTC is
 *   unavailable. The client owns its playback buffer and must truncate on barge-in.
 */
export type OpenAIRealtimeTransport = "webrtc" | "websocket";

export interface OpenAIRealtimeConfig extends Omit<RealtimeSessionOptions, "instructions" | "tools"> {
  transport?: OpenAIRealtimeTransport;
  /** WebRTC only: the caller's microphone (or other input) stream. The caller owns and stops it. */
  inputStream?: MediaStream;
  /** WebRTC only: the SDP offer endpoint. Defaults to OpenAI's. */
  callsUrl?: string;
  /** WebRTC only: extra headers on the SDP POST (e.g. `OpenAI-Safety-Identifier`). */
  callHeaders?: Record<string, string>;
  /** WebRTC only: how long to wait for ICE gathering before sending the offer, ms. Default 3000. */
  iceGatherTimeoutMs?: number;
  /** WebRTC only: STUN servers to use instead of the default. */
  iceServers?: RTCIceServer[];
  /** Called once the assistant's audio stream is available (WebRTC only). */
  onRemoteStream?: (stream: MediaStream) => void;
}

/**
 * OpenAI Realtime provider.
 *
 * Wires OpenAI's server-side voice activity detection and barge-in into this SDK's conversation
 * state machine, so callers get a single, ordered event stream (`VoiceAgentEvent`) instead of having
 * to reconcile raw realtime protocol events themselves.
 *
 * Turn-taking and interruption come from OpenAI's VAD, not from a local energy heuristic: the API
 * decides when the user stops talking (`user-speech-ended`) and when the user talks over the
 * assistant (`interruption`). That is what removes the need for a push-to-talk button.
 */
export function openaiRealtime(config: OpenAIRealtimeConfig = {}): VoiceProvider {
  return {
    name: "openai-realtime",
    async connect(options: VoiceConnectOptions): Promise<VoiceSession> {
      const agent = options.agent;

      // No credential configured at all → mock session, so the provider surface stays testable
      // without a key. `apiKey: "mock"` is the explicit opt-in used by the SDK's own tests.
      const isMockSentinel = config.apiKey === "mock" || config.clientSecret === "mock";
      const hasCredential =
        !isMockSentinel &&
        !!(config.clientSecret || config.getEphemeralKey || config.apiKey || (typeof process !== "undefined" && process.env?.OPENAI_API_KEY));
      if (!hasCredential && !config.url) {
        return createMockVoiceSession(agent);
      }

      const handlers = new Map<string, Set<(event: any) => void>>();
      function emit(event: VoiceAgentEvent): void {
        const set = handlers.get(event.type);
        if (!set) return;
        for (const h of [...set]) {
          try {
            h(event);
          } catch {}
        }
      }
      function subscribe(type: string, handler: (event: any) => void): () => void {
        let set = handlers.get(type);
        if (!set) {
          set = new Set();
          handlers.set(type, set);
        }
        set.add(handler);
        return () => set!.delete(handler);
      }

      const engine = new ConversationEngine({
        agent,
        onEvent: emit,
        interruptionMode: agent.voice?.interruption,
        maxSilenceMs: agent.voice?.maxSilenceMs,
      });

      const useWebRTC = config.transport === "webrtc" || (config.transport === undefined && !!config.inputStream);
      const remoteStreamHolder: { stream: MediaStream | null } = { stream: null };
      let connectionState: VoiceConnectionState = "connecting";
      let closed = false;
      /** Assistant audio for the response currently in flight, used for transcript pairing. */
      let assistantSpeaking = false;
      /** Set when the current assistant response was cut short by the user. */
      let interruptedThisResponse = false;
      const detachers: Array<() => void> = [];

      function setConnectionState(next: VoiceConnectionState, detail?: string): void {
        connectionState = next;
        switch (next) {
          case "connecting":
            engine.handleConnecting();
            break;
          case "connected":
            engine.handleConnected();
            break;
          case "reconnecting":
            engine.handleReconnecting(0);
            break;
          case "failed":
            engine.handleError();
            break;
          default:
            engine.handleConnecting();
        }
        emit({ type: "connection-state", state: next, detail });
      }

      const realtimeOptions: RealtimeSessionOptions = {
        ...config,
        instructions: agent.instructions,
        tools: agent.tools,
        turnDetection: config.turnDetection,
      };

      // ── WebRTC ──────────────────────────────────────────────────────────────
      let webrtc: OpenAIRealtimeWebRTCTransport | null = null;
      if (useWebRTC) {
        if (!config.inputStream) {
          throw new Error(
            "openaiRealtime({ transport: \"webrtc\" }) requires an inputStream. Request the microphone " +
              "first and pass the resulting MediaStream, so the app can surface permission errors itself."
          );
        }
        if (typeof RTCPeerConnection === "undefined") {
          throw new Error("This browser does not support WebRTC, which the Realtime API requires for browser audio.");
        }
        if (!config.clientSecret && !config.getEphemeralKey && !config.apiKey) {
          throw new Error(
            "openaiRealtime({ transport: \"webrtc\" }) requires a clientSecret (or getEphemeralKey). " +
              "Mint an ephemeral secret server-side with createRealtimeClientSecret() — never ship OPENAI_API_KEY to the browser."
          );
        }

        webrtc = new OpenAIRealtimeWebRTCTransport({
          clientSecret: config.clientSecret,
          getEphemeralKey: config.getEphemeralKey,
          inputStream: config.inputStream,
          callsUrl: config.callsUrl,
          headers: config.callHeaders,
          iceGatherTimeoutMs: config.iceGatherTimeoutMs,
          iceServers: config.iceServers,
        });

        detachers.push(
          webrtc.on("event", (rawEvent: any) => handleRealtimeMessage(rawEvent)),
          webrtc.on("error", (err: unknown) => {
            emit({ type: "run-failed", error: err instanceof Error ? err : new Error(String(err)) });
            setConnectionState("failed");
          }),
          webrtc.on("close", () => {
            if (!closed) setConnectionState("closed", "data-channel-closed");
          })
        );
      }

      // ── WebSocket ───────────────────────────────────────────────────────────
      const socket = useWebRTC ? null : createRealtimeSession(realtimeOptions);
      if (socket) {
        detachers.push(
          socket.on((event: RealtimeEvent) => handleRealtimeEvent(event)),
        );
      }

      // ── shared protocol handling ────────────────────────────────────────────

      /** Dispatches a realtime protocol event onto the conversation state machine. */
      function handleRealtimeEvent(event: RealtimeEvent): void {
        if (closed) return;
        switch (event.type) {
          case "session.ready":
            setConnectionState("connected");
            break;

          case "speech_started":
            // The user started talking. If the assistant held the turn, this is a barge-in: stop
            // its audio now, before anything else is processed.
            if (engine.isAssistantSpeaking()) {
              interruptedThisResponse = true;
              engine.handleUserBeganSpeakingOverAssistant({ confidence: 1, durationMs: 1000 });
              socket?.truncateLastResponse(0);
            } else {
              engine.handleUserSpeaking();
            }
            break;

          case "speech_stopped":
            // The turn ended. OpenAI decides when that is, so no local silence timer is needed.
            break;

          case "transcript.delta":
            if (event.role === "user") engine.handleUserTranscriptDelta(event.delta);
            else engine.handleAssistantTranscriptDelta(event.delta);
            break;

          case "transcript.done":
            if (event.role === "user") engine.handleUserTranscriptDone(event.transcript, 1);
            else engine.handleAssistantTranscriptDone(event.transcript, interruptedThisResponse);
            break;

          case "audio.delta":
            if (!assistantSpeaking) {
              assistantSpeaking = true;
              engine.handleAgentSpeaking();
            }
            engine.handleAgentAudioChunk(toArrayBuffer(event.audio));
            break;

          case "audio.done":
            if (assistantSpeaking) {
              assistantSpeaking = false;
              engine.handleAssistantStopped();
            }
            break;

          case "response.cancelled":
            emit({ type: "response-cancelled" });
            break;

          case "response.done":
            if (assistantSpeaking) {
              assistantSpeaking = false;
              engine.handleAssistantStopped();
            }
            interruptedThisResponse = false;
            // A response can end without ever producing audio (e.g. it was only a tool call).
            emit({ type: "run-completed", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
            break;

          case "tool_call":
            // The underlying session already executed the tool and replied to the model; this event
            // is purely for observation.
            emit({ type: "tool-started", toolName: event.name, args: event.args });
            break;

          case "connection":
            if (event.state === "closed") setConnectionState("closed", event.reason);
            else if (event.state === "failed") setConnectionState("failed", event.reason);
            break;

          case "error": {
            const err = event.error instanceof Error ? event.error : new Error(String(event.error ?? "Realtime error"));
            emit({ type: "run-failed", error: err });
            break;
          }

          default:
            break;
        }
      }

      /** WebRTC delivers the same protocol as raw JSON over the data channel. */
      function handleRealtimeMessage(raw: unknown): void {
        if (closed || !raw || typeof raw !== "object") return;
        const msg = raw as { type?: string; [key: string]: unknown };
        switch (msg.type) {
          case "session.created":
          case "session.updated":
            setConnectionState("connected");
            break;
          case "input_audio_buffer.speech_started":
            handleRealtimeEvent({ type: "speech_started" });
            break;
          case "input_audio_buffer.speech_stopped":
            handleRealtimeEvent({ type: "speech_stopped" });
            break;
          case "conversation.item.input_audio_transcription.delta":
            handleRealtimeEvent({ type: "transcript.delta", delta: msg.delta as string, role: "user" });
            break;
          case "conversation.item.input_audio_transcription.completed":
            handleRealtimeEvent({ type: "transcript.done", transcript: msg.transcript as string, role: "user" });
            break;
          case "response.output_audio_transcript.delta":
          case "response.audio_transcript.delta":
            handleRealtimeEvent({ type: "transcript.delta", delta: msg.delta as string, role: "assistant" });
            break;
          case "response.output_audio_transcript.done":
          case "response.audio_transcript.done":
            handleRealtimeEvent({ type: "transcript.done", transcript: msg.transcript as string, role: "assistant" });
            break;
          case "response.done":
            handleRealtimeEvent({ type: "response.done" });
            break;
          case "response.cancelled":
            handleRealtimeEvent({ type: "response.cancelled" });
            break;
          case "error":
            handleRealtimeEvent({ type: "error", error: msg.error ?? msg });
            break;
          default:
            break;
        }
      }

      // ── connect ─────────────────────────────────────────────────────────────
      setConnectionState("connecting");
      try {
        if (webrtc) {
          const call: NegotiatedRealtimeCall = await webrtc.negotiate();
          remoteStreamHolder.stream = call.remoteStream;
          config.onRemoteStream?.(call.remoteStream);
          // On WebRTC the media path is established by the tracks themselves; the data channel only
          // carries events, and OpenAI applies the session defaults from the SDP negotiation. Tools
          // are the one thing the client must still register, so update the session with them.
          webrtc.sendQuiet({
            type: "session.update",
            session: buildWebRtcSessionConfig(options.agent, config),
          });
          setConnectionState("connected");
        } else if (socket) {
          await socket.connect();
          setConnectionState("connected");
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setConnectionState("failed", error.message);
        emit({ type: "run-failed", error });
        // Still hand back a usable session so callers can clean up symmetrically.
      }

      const session: VoiceSession = {
        sendAudio(chunk: ArrayBuffer) {
          // On WebRTC the microphone track is the audio path; there is nothing to hand-encode.
          if (closed) return;
          try {
            socket?.sendAudio(chunk);
          } catch {}
        },
        interrupt() {
          if (closed) return;
          interruptedThisResponse = assistantSpeaking;
          socket?.interrupt();
          webrtc?.sendQuiet({ type: "response.cancel" });
          if (assistantSpeaking) {
            assistantSpeaking = false;
            engine.handleAssistantInterrupted();
          }
          emit({ type: "interruption", reason: "explicit" });
        },
        sendText(text: string) {
          if (closed) return;
          if (socket) {
            socket.sendText(text);
            return;
          }
          webrtc?.sendQuiet({
            type: "conversation.item.create",
            item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
          });
          webrtc?.sendQuiet({ type: "response.create" });
        },
        getConnectionState() {
          return connectionState;
        },
        getRemoteStream() {
          return remoteStreamHolder.stream;
        },
        async close() {
          if (closed) return;
          closed = true;
          for (const detach of detachers) {
            try {
              detach();
            } catch {}
          }
          detachers.length = 0;
          try {
            socket?.close();
          } catch {}
          try {
            webrtc?.close();
          } catch {}
          handlers.clear();
          remoteStreamHolder.stream = null;
          connectionState = "closed";
        },
        on(type, handler) {
          return subscribe(type, handler as (event: any) => void);
        },
      };

      return session;
    },
  };
}

/**
 * Session config sent over a WebRTC data channel. WebRTC negotiates media at connection time, so
 * this only needs to register the things the SDP handshake can't: instructions, tools, and turn
 * detection.
 */
function buildWebRtcSessionConfig(
  agent: VoiceConnectOptions["agent"],
  config: OpenAIRealtimeConfig
): Record<string, unknown> {
  const turn = config.turnDetection;
  return {
    type: "realtime",
    model: config.model,
    // GA accepts exactly one output modality: `["text"]` or `["audio"]`. Requesting both is a 400.
    // Audio is the correct choice for a voice agent, and it does not cost us captions: the
    // assistant transcript still arrives on `response.output_audio_transcript.delta`.
    output_modalities: ["audio"],
    instructions: agent.instructions,
    audio: {
      input: {
        transcription:
          config.inputAudioTranscription === null
            ? undefined
            : { model: config.inputAudioTranscription?.model ?? "gpt-4o-transcribe" },
        turn_detection:
          turn === null
            ? null
            : {
                type: turn?.type ?? "semantic_vad",
                ...(turn?.threshold !== undefined ? { threshold: turn.threshold } : {}),
                ...(turn?.silenceDurationMs !== undefined ? { silence_duration_ms: turn.silenceDurationMs } : {}),
                ...(turn?.prefixPaddingMs !== undefined ? { prefix_padding_ms: turn.prefixPaddingMs } : {}),
                ...(turn?.eagerness !== undefined ? { eagerness: turn.eagerness } : {}),
                // Barge-in: the API cancels the in-flight response the moment the user speaks.
                interrupt_response: turn?.interruptResponse ?? true,
                create_response: turn?.createResponse ?? true,
              },
      },
      output: { voice: agent.voice?.voiceId ?? config.voice ?? "alloy" },
    },
    tools: (agent.tools ?? []).map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: toolParametersJsonSchema(tool),
    })),
    tool_choice: "auto",
  };
}

/** Inert session used when no credential is configured, so the provider stays testable. */
function createMockVoiceSession(agent: VoiceConnectOptions["agent"]): VoiceSession {
  const handlers = new Map<string, Set<(event: any) => void>>();
  const trace = createTrace(randomUUID(), agent.name);
  function emit(event: VoiceAgentEvent): void {
    for (const h of [...(handlers.get(event.type) ?? [])]) {
      try {
        h(event as any);
      } catch {}
    }
  }
  const session: VoiceSession & { _trace?: RunTrace } = {
    sendAudio() {},
    interrupt() {
      emit({ type: "interruption", reason: "explicit" });
    },
    async close() {
      handlers.clear();
      finishTrace(trace);
    },
    getConnectionState() {
      return "closed";
    },
    getRemoteStream() {
      return null;
    },
    on(type, handler) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler as (event: any) => void);
      return () => set!.delete(handler as (event: any) => void);
    },
    _trace: trace,
  };
  return session;
}

export type { RealtimeTurnDetection };
