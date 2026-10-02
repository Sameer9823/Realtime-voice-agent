export interface ShapingOptions { backchannelEnabled?: boolean; backchannelIntervalMs?: number; }
const BACKCHANNELS = ["mm-hmm", "got it", "right", "okay"];
export class ResponseShaper {
  private enabled: boolean; private intervalMs: number; private lastAt = 0; private seen = new Set<string>();
  constructor(opts: ShapingOptions = {}) { this.enabled = opts.backchannelEnabled ?? false; this.intervalMs = opts.backchannelIntervalMs ?? 8000; }
  lengthHint(input: string): "short" | "medium" | "long" { const t = input.trim(); const shortRe = /^(yes|no|okay|ok|sure|thanks|thank you)[.!?]?\$/i; if (t.length < 40 && shortRe.test(t)) return "short"; if (t.length < 120) return "medium"; return "long"; }
  shapingPromptSuffix(input: string): string { const h = this.lengthHint(input); if (h === "short") return "Reply concisely in one short sentence."; if (h === "medium") return "Reply helpfully in 2-3 sentences."; return "Reply helpfully with appropriate detail."; }
  shouldBackchannel(nowMs: number, longTurn: boolean): boolean { if (!this.enabled) return false; if (!longTurn) return false; if (nowMs - this.lastAt < this.intervalMs) return false; return true; }
  nextBackchannel(): string { this.lastAt = Date.now(); return BACKCHANNELS[Math.floor(Math.random() * BACKCHANNELS.length)]; }
  markSeen(fact: string): void { this.seen.add(fact.toLowerCase().trim()); }
  hasSeen(fact: string): boolean { return this.seen.has(fact.toLowerCase().trim()); }
  filterNewFacts(facts: string[]): string[] { return facts.filter((f) => !this.hasSeen(f)); }
  reset(): void { this.seen.clear(); this.lastAt = 0; }
}
