import type { Session } from "../../session.js";
export type GoalStatus = "in-progress" | "completed" | "abandoned";
export interface TrackedGoal { goal: string; status: GoalStatus; collected: Record<string, unknown>; requiredFields: string[]; updatedAt: number; }
export interface IntentTrackerOptions { session?: Session; storageKey?: string; }
export class IntentTracker {
  private goals: TrackedGoal[] = [];
  private currentGoal: TrackedGoal | null = null;
  private session?: Session;
  private storageKey: string;
  constructor(options: IntentTrackerOptions = {}) { this.session = options.session; this.storageKey = options.storageKey ?? "__voice_goal__"; }
  async load(): Promise<void> {
    if (!this.session) return;
    try { const msgs = await this.session.getMessages(); for (const m of msgs) { if (typeof m.content === "string" && m.content.startsWith(this.storageKey)) { const raw = m.content.slice(this.storageKey.length); const parsed = JSON.parse(raw) as TrackedGoal[]; if (Array.isArray(parsed)) this.goals = parsed; const cur = this.goals.find((g) => g.status === "in-progress"); if (cur) this.currentGoal = cur; } } } catch {}
  }
  private async persist(): Promise<void> { if (!this.session) return; try { await this.session.appendMessages([{ role: "system", content: this.storageKey + JSON.stringify(this.goals) }]); } catch {} }
  setGoal(goal: string, requiredFields: string[] = []): TrackedGoal {
    if (this.currentGoal && this.currentGoal.status === "in-progress") this.currentGoal.status = "abandoned";
    const g: TrackedGoal = { goal, status: "in-progress", collected: {}, requiredFields, updatedAt: Date.now() };
    this.goals.push(g); this.currentGoal = g; void this.persist(); return g;
  }
  updateCollected(fields: Record<string, unknown>): void {
    if (!this.currentGoal) return; Object.assign(this.currentGoal.collected, fields); this.currentGoal.updatedAt = Date.now();
    if (this.currentGoal.requiredFields.length > 0 && this.currentGoal.requiredFields.every((k) => this.currentGoal!.collected[k] !== undefined && this.currentGoal!.collected[k] !== "")) this.currentGoal.status = "completed";
    void this.persist();
  }
  applyCorrection(correction: Record<string, unknown>): void { this.updateCollected(correction); }
  completeCurrentGoal(): void { if (!this.currentGoal) return; this.currentGoal.status = "completed"; this.currentGoal.updatedAt = Date.now(); void this.persist(); }
  abandonCurrentGoal(): void { if (!this.currentGoal) return; this.currentGoal.status = "abandoned"; this.currentGoal.updatedAt = Date.now(); void this.persist(); }
  getCurrentGoal(): TrackedGoal | null { return this.currentGoal; }
  getGoals(): TrackedGoal[] { return [...this.goals]; }
  missingFields(): string[] { if (!this.currentGoal) return []; return this.currentGoal.requiredFields.filter((k) => this.currentGoal!.collected[k] === undefined || this.currentGoal!.collected[k] === ""); }
  hasCollected(key: string): boolean { return !!this.currentGoal && this.currentGoal.collected[key] !== undefined && this.currentGoal!.collected[key] !== ""; }
  filterAlreadyProvided(needed: string[]): string[] { return needed.filter((k) => !this.hasCollected(k)); }
}
