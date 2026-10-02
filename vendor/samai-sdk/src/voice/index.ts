// ── Voice agent orchestration ────────────────────────────────────────────────
export { defineVoiceAgent, runVoiceAgent } from "./voice-agent.js";
export type { VoiceAgent, RunVoiceAgentOptions } from "./voice-agent.js";

// ── Conversation state machine ───────────────────────────────────────────────
export { ConversationEngine } from "./conversation-engine.js";
export type { ConversationEngineOptions, ConversationState } from "./conversation-engine.js";

// ── Turn taking & interruption ───────────────────────────────────────────────
export { VoiceActivityDetector, hasSentenceBoundary, splitAtSentenceBoundaries } from "./pipeline/vad.js";
export type { VADOptions, VADResult, VADState } from "./pipeline/vad.js";
export { InterruptionController } from "./interruption.js";
export type { InterruptionDecision, InterruptionMode, BargeInCandidate } from "./interruption.js";

// ── Realtime providers ───────────────────────────────────────────────────────
export { openaiRealtime } from "./realtime/openai-realtime.js";
export type { OpenAIRealtimeConfig, OpenAIRealtimeTransport } from "./realtime/openai-realtime.js";
export { createRealtimeSession } from "../voice.js";
export type {
  RealtimeAudioEncoding,
  RealtimeConnectionState,
  RealtimeEvent,
  RealtimeInputTranscription,
  RealtimeSession,
  RealtimeSessionOptions,
  RealtimeTurnDetection,
} from "../voice.js";

// ── Transports ───────────────────────────────────────────────────────────────
export { WebRTCVoiceTransport, stopMediaStream } from "./transport/webrtc.js";
export { OpenAIRealtimeWebRTCTransport, createRealtimeClientSecret } from "./transport/openai-webrtc.js";
export type { OpenAIWebRTCTransportOptions, NegotiatedRealtimeCall } from "./transport/openai-webrtc.js";
export { createOffer, handleAnswer, handleOffer, addIceCandidate } from "./transport/webrtc-signaling.js";

// ── Tools ────────────────────────────────────────────────────────────────────
// Re-exported here so a browser app can define tools without importing the root entry, which pulls
// in Node-only modules (sandbox, session stores) and breaks the client bundle.
export { defineTool } from "../types.js";
export type { ToolDefinition } from "../types.js";
export { toolParametersJsonSchema } from "../schema-adapter.js";

// ── STT / TTS (pipeline provider) ────────────────────────────────────────────
export { pipelineVoice } from "./pipeline/pipeline-provider.js";
export type { PipelineVoiceOptions } from "./pipeline/pipeline-provider.js";
export { deepgramSTT } from "./stt/deepgram.js";
export { elevenLabsTTS } from "./tts/elevenlabs.js";
export type { STTProvider, STTResult, STTSession, STTStreamOptions } from "./stt/types.js";
export type { TTSProvider, TTSOptions, TTSSession } from "./tts/types.js";

// ── Test doubles ─────────────────────────────────────────────────────────────
export {
  createMockSTTProvider,
  createMockTTSProvider,
  createMockVoiceTransport,
} from "./testing.js";

// ── Shared types ─────────────────────────────────────────────────────────────
export type * from "./types.js";
