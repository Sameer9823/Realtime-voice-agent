import type { ToolDefinition, Usage } from "../types.js";
import type { Session } from "../session.js";

export interface VoiceAgentConfig {
  name: string;
  instructions: string;
  model: string;
  tools?: ToolDefinition[];
  handoffs?: VoiceAgentConfig[];
  voice?: {
    voiceId?: string;
    interruption?: "always-allow" | "confidence-gated" | "disabled";
    backchannel?: boolean;
    maxSilenceMs?: number;
  };
}

export interface VoiceConnectOptions {
  agent: VoiceAgentConfig;
  session?: Session;
  onApprovalRequest?: (req: { toolName: string; args: unknown }) => Promise<boolean>;
}

/** Transport-level connection state, surfaced to callers so they can drive reconnect logic. */
export type VoiceConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "failed";

export interface VoiceProvider {
  name?: string;
  connect(options: VoiceConnectOptions): Promise<VoiceSession>;
}

export interface VoiceSession {
  sendAudio(chunk: ArrayBuffer): void;
  interrupt(): void;
  close(): Promise<void>;
  on<E extends VoiceAgentEvent["type"]>(
    type: E,
    handler: (event: Extract<VoiceAgentEvent, { type: E }>) => void
  ): () => void;
  /** Sends a text turn instead of audio, when the provider supports it. */
  sendText?(text: string): void;
  /** Current transport connection state. */
  getConnectionState?(): VoiceConnectionState;
  /**
   * The assistant's audio output stream, when the provider returns media directly (WebRTC) rather
   * than PCM chunks. Attach it to an `<audio>` element to play the assistant's voice.
   */
  getRemoteStream?(): MediaStream | null;
}

export type VoiceAgentEvent =
  | { type: "user-speech-started" }
  | { type: "user-speech-ended"; transcript: string; confidence: number }
  /** Streaming user transcript, emitted as words are recognised. Empty text means a fresh turn. */
  | { type: "user-transcript-delta"; delta: string }
  | { type: "agent-thinking" }
  | { type: "agent-speech-started" }
  | { type: "agent-audio-chunk"; chunk: ArrayBuffer }
  | { type: "agent-speech-ended" }
  /** Streaming assistant transcript, emitted while the assistant speaks. */
  | { type: "assistant-transcript-delta"; delta: string }
  /** Final assistant transcript for a completed (possibly interrupted) response. */
  | { type: "assistant-transcript-done"; transcript: string }
  /** The assistant's response was cut short — by barge-in or an explicit interrupt. */
  | { type: "response-cancelled" }
  | { type: "interruption"; reason: "user-barge-in" | "explicit" | "low-confidence-transcript" }
  | { type: "tool-started"; toolName: string; args: unknown }
  | { type: "tool-completed"; toolName: string; result: unknown }
  | { type: "clarification-requested"; question: string }
  | { type: "goal-updated"; goal: string; status: "in-progress" | "completed" | "abandoned" }
  /** Transport lifecycle, for connection UI and reconnect handling. */
  | { type: "connection-state"; state: VoiceConnectionState; attempt?: number; detail?: string }
  | { type: "run-completed"; usage: Usage }
  | { type: "run-failed"; error: Error };
