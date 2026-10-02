export interface ClarificationDecision { shouldClarify: boolean; question?: string; }
export interface ClarificationInput { transcript: string; confidence: number; intentAmbiguous: boolean; missingFields?: string[]; }
const LOW = 0.55;
const KEYS = ["maybe", "or", "either", "not sure", "could be"];
function looksAmbiguous(t: string): boolean { const low = t.toLowerCase(); return KEYS.some((k) => low.includes(k)) || t.trim().endsWith("?"); }
export class ClarificationPolicy {
  private lowThreshold: number;
  constructor(opts: { lowConfidenceThreshold?: number } = {}) { this.lowThreshold = opts.lowConfidenceThreshold ?? LOW; }
  decide(input: ClarificationInput): ClarificationDecision {
    if (input.confidence < this.lowThreshold) { const s = input.transcript.trim().slice(0, 80); const q = s ? 'Sorry, I missed the last part — what did you say? I heard something like "' + s + '" but I want to be sure.' : "Sorry, I did not catch that — could you say it again?"; return { shouldClarify: true, question: q }; }
    if (input.intentAmbiguous) { const hasMissing = (input.missingFields?.length ?? 0) > 0; const amb = looksAmbiguous(input.transcript); if (hasMissing || amb) { const q2 = input.missingFields && input.missingFields.length > 0 ? "Just to confirm — could you tell me the " + input.missingFields.join(" and ") + "?" : "Just to make sure I understood — could you clarify what you meant?"; return { shouldClarify: true, question: q2 }; } }
    return { shouldClarify: false };
  }
}
