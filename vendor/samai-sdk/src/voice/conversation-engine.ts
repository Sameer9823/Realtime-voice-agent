import type { VoiceAgentConfig, VoiceAgentEvent } from "./types.js";
import { VoiceActivityDetector, hasSentenceBoundary } from "./pipeline/vad.js";
import { InterruptionController, type InterruptionMode } from "./interruption.js";
import { IntentTracker } from "./behavior/intent-tracker.js";
import { ClarificationPolicy } from "./behavior/clarification-policy.js";
import { ResponseShaper } from "./behavior/response-shaping.js";
import type { RunTrace } from "../trace.js";
import { recordEvent } from "../trace.js";

export type ConversationState =
  /** No session, or the session was closed. */
  | "idle"
  /** Transport is being established. */
  | "connecting"
  /** Session is up and waiting for the user to say something. */
  | "listening"
  /** The user is mid-utterance. */
  | "user_speaking"
  /** The user's turn ended; the assistant is composing a response. */
  | "thinking"
  /** Legacy alias for `assistant_speaking`, kept for the pipeline provider. */
  | "speaking"
  | "assistant_speaking"
  /** The assistant was cut off; the audio is being stopped. */
  | "interrupting"
  /** Legacy alias for `interrupting`, kept for the pipeline provider. */
  | "interrupted"
  /** The transport dropped and a new session is being established. */
  | "reconnecting"
  /** Unrecoverable failure. */
  | "error";

export interface ConversationEngineOptions {
  agent: VoiceAgentConfig;
  session?: import("../session.js").Session;
  trace?: RunTrace;
  onEvent?: (event: VoiceAgentEvent) => void;
  interruptionMode?: InterruptionMode;
  maxSilenceMs?: number;
}
export class ConversationEngine {
  private state: ConversationState = "idle";
  private agent: VoiceAgentConfig;
  private trace?: RunTrace;
  private onEvent?: (e: VoiceAgentEvent) => void;
  private vad: VoiceActivityDetector;
  private interruption: InterruptionController;
  private intentTracker: IntentTracker;
  private clarification: ClarificationPolicy;
  private shaper: ResponseShaper;
  private maxSilenceMs: number;
  private currentTranscript = "";
  private partialContext = "";
  private isSpeakingLongTurn = false;
  private reconnectAttempt = 0;
  constructor(opts: ConversationEngineOptions) {
    this.agent = opts.agent;
    this.trace = opts.trace;
    this.onEvent = opts.onEvent;
    this.maxSilenceMs = opts.maxSilenceMs ?? opts.agent.voice?.maxSilenceMs ?? 700;
    const mode = (opts.interruptionMode ?? opts.agent.voice?.interruption ?? "confidence-gated") as InterruptionMode;
    this.vad = new VoiceActivityDetector({ silenceMs: this.maxSilenceMs });
    this.interruption = new InterruptionController(mode, this.vad);
    this.intentTracker = new IntentTracker({ session: opts.session });
    this.clarification = new ClarificationPolicy();
    this.shaper = new ResponseShaper({ backchannelEnabled: !!opts.agent.voice?.backchannel });
  }
  getState(): ConversationState { return this.state; }
  getIntentTracker(): IntentTracker { return this.intentTracker; }
  getPartialContext(): string { return this.partialContext; }
  /**
   * Transport lifecycle. Kept out of the event stream (it isn't a `VoiceAgentEvent`) so callers read
   * it by polling `getState()`, which is what a reconnect loop needs.
   */
  handleConnecting(): void { this.state = "connecting"; }
  handleConnected(): void {
    this.state = "listening";
    this.vad.reset();
    this.interruption.reset();
  }
  handleReconnecting(attempt: number): void { this.state = "reconnecting"; this.reconnectAttempt = attempt; }
  handleError(): void { this.state = "error"; }
  getReconnectAttempt(): number { return this.reconnectAttempt; }
  /** True while the assistant holds the turn. */
  isAssistantSpeaking(): boolean { return this.state === "speaking" || this.state === "assistant_speaking"; }
  private emit(event: VoiceAgentEvent): void {
    if (this.onEvent) this.onEvent(event);
    if (this.trace) {
      if (event.type === "user-speech-ended") recordEvent(this.trace, { type: "voice-turn", agentName: this.agent.name, transcript: event.transcript } as any);
      else if (event.type === "interruption") recordEvent(this.trace, { type: "interruption", agentName: this.agent.name, reason: event.reason } as any);
      else if (event.type === "clarification-requested") recordEvent(this.trace, { type: "clarification", agentName: this.agent.name, question: event.question } as any);
      else if (event.type === "goal-updated") recordEvent(this.trace, { type: "goal-update", agentName: this.agent.name, goal: event.goal, status: event.status } as any);
    }
  }
  handleUserSpeechStarted(): void { this.state = "listening"; this.currentTranscript = ""; this.emit({ type: "user-speech-started" }); }
  /**
   * The realtime path: the transport's server-side VAD reported the user started talking. Kept
   * distinct from `handleUserSpeechStarted()` so the pipeline's `listening` state is unchanged.
   */
  handleUserSpeaking(): void { this.state = "user_speaking"; this.currentTranscript = ""; this.emit({ type: "user-speech-started" }); }
  /** Streaming user transcript. An empty delta marks the start of a new turn. */
  handleUserTranscriptDelta(delta: string): void {
    if (!delta) this.currentTranscript = "";
    else this.currentTranscript += delta;
    this.emit({ type: "user-transcript-delta", delta });
  }
  handleUserTranscriptDone(transcript: string, confidence: number): void {
    this.currentTranscript = transcript;
    this.handleUserSpeechEnded(transcript, confidence);
  }
  /** Streaming assistant transcript, while audio is being produced for the same response. */
  handleAssistantTranscriptDelta(delta: string): void {
    this.emit({ type: "assistant-transcript-delta", delta });
  }
  /** Final assistant transcript. `interrupted` marks a response the user cut short. */
  handleAssistantTranscriptDone(transcript: string, interrupted = false): void {
    this.emit({ type: "assistant-transcript-done", transcript });
    if (interrupted) this.emit({ type: "response-cancelled" });
  }
  /**
   * The user started talking while the assistant was speaking. Moves to `interrupting` so the
   * caller can stop playback immediately, and applies the configured barge-in gate — a cough or a
   * keyboard click should not cut the assistant off.
   */
  handleUserBeganSpeakingOverAssistant(candidate: { confidence: number; durationMs: number; transcript?: string } = { confidence: 1, durationMs: 1000 }): boolean {
    if (this.isAssistantSpeaking()) {
      const gated = this.interruption.observeWhileSpeaking(candidate);
      if (!gated.shouldInterrupt) return false;
      this.state = "interrupting";
      this.emit({ type: "interruption", reason: gated.reason! });
      return true;
    }
    this.handleUserSpeaking();
    return true;
  }
  handleUserSpeechEnded(transcript: string, confidence: number): VoiceAgentEvent | null {
    const isCorrection = /^\s*(no[,\s]+|actually[\s]*|i meant[\s]*|correction)/i.test(transcript);
    if (isCorrection && this.partialContext) {
      this.currentTranscript = transcript.replace(/^\s*(no[,\s]+|actually[\s]*|i meant[\s]*|correction[\s]*)/i, "").trim();
      this.intentTracker.applyCorrection({ correction: this.currentTranscript });
    } else {
      this.currentTranscript = transcript;
    }
    this.partialContext = this.currentTranscript;
    this.emit({ type: "user-speech-ended", transcript: this.currentTranscript, confidence });
    const clarDecision = this.clarification.decide({ transcript: this.currentTranscript, confidence, intentAmbiguous: false });
    if (clarDecision.shouldClarify) { this.emit({ type: "clarification-requested", question: clarDecision.question! }); return { type: "clarification-requested", question: clarDecision.question! }; }
    return null;
  }
  handleAgentThinking(): void { this.state = "thinking"; this.emit({ type: "agent-thinking" }); }
  handleAgentSpeechStarted(): void { this.state = "speaking"; this.isSpeakingLongTurn = false; this.emit({ type: "agent-speech-started" }); }
  /**
   * The realtime path, which distinguishes "the assistant is audible" from "the assistant has been
   * interrupted but its audio is still draining". Keeps the pipeline's `speaking` state unchanged.
   */
  handleAgentSpeaking(): void { this.state = "assistant_speaking"; this.isSpeakingLongTurn = false; this.emit({ type: "agent-speech-started" }); }
  handleAssistantStopped(): void { this.state = "listening"; this.emit({ type: "agent-speech-ended" }); }
  /** The assistant was cut off by the user; back to listening for their continued turn. */
  handleAssistantInterrupted(): void { this.state = "listening"; this.emit({ type: "agent-speech-ended" }); }
  handleAgentAudioChunk(chunk: ArrayBuffer): void { this.emit({ type: "agent-audio-chunk", chunk }); }
  handleAgentSpeechEnded(): void { if (this.state === "speaking" || this.state === "interrupted" || this.state === "assistant_speaking" || this.state === "interrupting") { this.state = "idle"; this.emit({ type: "agent-speech-ended" }); } }
  handleBargeIn(candidate: { confidence: number; durationMs: number; transcript?: string }): boolean {
    if (!this.isAssistantSpeaking()) return false;
    const decision = this.interruption.observeWhileSpeaking(candidate);
    if (!decision.shouldInterrupt) return false;
    this.state = "interrupted";
    this.emit({ type: "interruption", reason: decision.reason! });
    return true;
  }
  handleExplicitInterrupt(): void { this.state = "interrupted"; this.emit({ type: "interruption", reason: "explicit" }); }
  handleRunCompleted(usage: import("../types.js").Usage): void { this.state = "idle"; this.emit({ type: "run-completed", usage }); }
  handleRunFailed(error: Error): void { this.state = "idle"; this.emit({ type: "run-failed", error }); }
  handleToolStarted(toolName: string, args: unknown): void { this.emit({ type: "tool-started", toolName, args }); }
  handleToolCompleted(toolName: string, result: unknown): void { this.emit({ type: "tool-completed", toolName, result }); }
  setGoal(goal: string, requiredFields: string[] = []): void { const g = this.intentTracker.setGoal(goal, requiredFields); this.emit({ type: "goal-updated", goal: g.goal, status: g.status }); }
  updateGoalFields(fields: Record<string, unknown>): void { this.intentTracker.updateCollected(fields); const g = this.intentTracker.getCurrentGoal(); if (g) this.emit({ type: "goal-updated", goal: g.goal, status: g.status }); }
  getShapingSuffix(input: string): string { return this.shaper.shapingPromptSuffix(input); }
  maybeBackchannel(nowMs: number): string | null { if (this.shaper.shouldBackchannel(nowMs, this.isSpeakingLongTurn)) return this.shaper.nextBackchannel(); return null; }
  markSpeakingLongTurn(v: boolean): void { this.isSpeakingLongTurn = v; }
  hasSentenceBoundary(text: string): boolean { return hasSentenceBoundary(text); }
  getMaxSilenceMs(): number { return this.maxSilenceMs; }
}
