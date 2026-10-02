import { VoiceActivityDetector } from "./pipeline/vad.js";
export type InterruptionMode = "always-allow" | "confidence-gated" | "disabled";
export interface InterruptionDecision { shouldInterrupt: boolean; reason?: "user-barge-in" | "low-confidence-transcript"; }
export interface BargeInCandidate { confidence: number; durationMs: number; transcript?: string; }
export class InterruptionController {
  private vad: VoiceActivityDetector;
  private mode: InterruptionMode;
  constructor(mode: InterruptionMode = "confidence-gated", vad?: VoiceActivityDetector) {
    this.mode = mode;
    this.vad = vad ?? new VoiceActivityDetector();
  }
  setMode(mode: InterruptionMode): void { this.mode = mode; }
  observeWhileSpeaking(candidate: BargeInCandidate): InterruptionDecision {
    if (this.mode === "disabled") return { shouldInterrupt: false };
    const ok = this.vad.isBargeIn(candidate, this.mode);
    if (!ok) return { shouldInterrupt: false };
    return { shouldInterrupt: true, reason: "user-barge-in" };
  }
  shouldClarifyInstead(confidence: number, threshold = 0.5): boolean { return confidence < threshold; }
  reset(): void { this.vad.reset(); }
}
