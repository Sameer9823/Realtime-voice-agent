/**
 * UI-facing voice types.
 *
 * The conversation state machine itself lives in the SamAI SDK (`ConversationEngine`); these types
 * mirror it for rendering, plus the transcript model the transcript panel consumes.
 */

import type { ConversationState } from "samai-sdk/voice";

/**
 * States the interface can be in. This is the SamAI SDK's `ConversationState` — the app reads it
 * rather than inventing a parallel state machine.
 */
export type VoiceState = ConversationState;

/** Which side currently holds the conversational turn. Drives orb styling and the status line. */
export type TurnOwner = "none" | "user" | "assistant";

export type TranscriptEntryStatus = "streaming" | "final" | "interrupted";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: TranscriptEntryStatus;
  startedAt: number;
  /** True when the user cut this response off, so the UI can mark it as not fully delivered. */
  interrupted?: boolean;
}

/** User-facing error categories. Raw WebRTC/OpenAI exceptions never reach the UI. */
export type VoiceErrorKind =
  | "unsupported_browser"
  | "microphone_unavailable"
  | "permission_denied"
  | "audio_capture_failed"
  | "auth_failed"
  | "rate_limited"
  | "connection_failed"
  | "session_failed"
  | "model_unavailable"
  | "unknown";

export interface VoiceError {
  kind: VoiceErrorKind;
  /** Short, human-readable message. Safe to show to the user. */
  message: string;
  /** Whether retrying could plausibly help. */
  retryable: boolean;
}

export interface VoiceCapabilities {
  supported: boolean;
  getUserMedia: boolean;
  webRTC: boolean;
  audioContext: boolean;
  /** Human-readable list of what's missing, when `supported` is false. */
  missing: string[];
}

/** Request body/response shape for the server route that mints ephemeral credentials. */
export interface SessionRequestBody {
  model?: string;
  voice?: string;
}

export interface SessionResponseBody {
  /** Ephemeral `ek_...` client secret. Short-lived, browser-safe, never the long-lived key. */
  clientSecret: string;
  expiresAt: number | null;
  model: string;
  voice: string;
}

export interface SessionErrorBody {
  error: VoiceErrorKind;
  message: string;
}