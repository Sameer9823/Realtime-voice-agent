export interface VADOptions {
  /** Energy threshold 0-1. Default 0.3 */
  energyThreshold?: number;
  /** Minimum speech duration to trigger barge-in, ms. Default 250 */
  minSpeechDurationMs?: number;
  /** Minimum confidence to count as speech. Default 0.6 */
  minConfidence?: number;
  /** Silence to consider speech ended, ms. Default 700 */
  silenceMs?: number;
}

export interface VADResult {
  isSpeech: boolean;
  confidence: number;
  energy: number;
}

export interface VADState {
  isSpeaking: boolean;
  speechStartMs: number | null;
  lastSpeechMs: number | null;
}

/**
 * Lightweight VAD tuned against false positives (coughs, keyboard, TV).
 * Deterministic/heuristic — no model call.
 * Callers feed audio energy/confidence externally; this class tracks state.
 */
export class VoiceActivityDetector {
  private opts: Required<VADOptions>;
  private state: VADState = { isSpeaking: false, speechStartMs: null, lastSpeechMs: null };

  constructor(options: VADOptions = {}) {
    this.opts = {
      energyThreshold: options.energyThreshold ?? 0.3,
      minSpeechDurationMs: options.minSpeechDurationMs ?? 250,
      minConfidence: options.minConfidence ?? 0.6,
      silenceMs: options.silenceMs ?? 700,
    };
  }

  process(chunk: { energy: number; confidence: number; timestamp: number }): VADResult {
    const isSpeech = chunk.energy >= this.opts.energyThreshold && chunk.confidence >= this.opts.minConfidence;
    if (isSpeech) {
      if (!this.state.isSpeaking) {
        this.state.isSpeaking = true;
        this.state.speechStartMs = chunk.timestamp;
      }
      this.state.lastSpeechMs = chunk.timestamp;
    } else {
      if (this.state.isSpeaking && this.state.lastSpeechMs !== null) {
        if (chunk.timestamp - this.state.lastSpeechMs >= this.opts.silenceMs) {
          this.state.isSpeaking = false;
          this.state.speechStartMs = null;
        }
      }
    }
    return { isSpeech, confidence: chunk.confidence, energy: chunk.energy };
  }

  /**
   * Whether current speech is long/confident enough to count as a real barge-in,
   * not a cough/blip.
   */
  isBargeIn(candidate: { confidence: number; durationMs: number }, mode: "always-allow" | "confidence-gated" | "disabled"): boolean {
    if (mode === "disabled") return false;
    if (mode === "always-allow") return candidate.durationMs >= 50;
    // confidence-gated (default): requires sustained high-confidence speech
    return candidate.confidence >= this.opts.minConfidence && candidate.durationMs >= this.opts.minSpeechDurationMs;
  }

  reset(): void {
    this.state = { isSpeaking: false, speechStartMs: null, lastSpeechMs: null };
  }

  getState(): VADState {
    return { ...this.state };
  }
}

/** Heuristic sentence-boundary detection for low-latency TTS start */
export function hasSentenceBoundary(text: string): boolean {
  return /[.!?]\s*$/.test(text.trim()) || /[.!?]["')]*\s*$/.test(text.trim());
}

export function splitAtSentenceBoundaries(text: string): string[] {
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if (/[.!?]/.test(text[i])) {
      const next = text.slice(i + 1, i + 3);
      if (next.trim() === "" || i === text.length - 1) {
        if (buf.trim()) parts.push(buf.trim());
        buf = "";
      }
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}
