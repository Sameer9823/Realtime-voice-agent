import { IntentTracker } from "../src/voice/behavior/intent-tracker.js";
import { createSession, InMemorySessionStore } from "../src/session.js";

let failures = 0;
function check(label: string, cond: boolean, detail="") {
  if (cond) console.log(`  \u2705 ${label}${detail ? " \u2014 "+detail : ""}`);
  else { console.log(`  \u274c ${label}${detail ? " \u2014 "+detail : ""}`); failures++; }
}

console.log("=== TEST: IntentTracker goal lifecycle ===");
const tracker = new IntentTracker();

tracker.setGoal("book a flight", ["origin", "destination", "date"]);
check("current goal is book a flight", tracker.getCurrentGoal()?.goal === "book a flight");
check("missingFields has 3 initially", tracker.missingFields().length === 3);
check("filterAlreadyProvided returns all when nothing collected", tracker.filterAlreadyProvided(["origin","destination"]).length === 2);

tracker.updateCollected({ origin: "NYC" });
check("after origin collected, missingFields 2", tracker.missingFields().length === 2);
check("hasCollected origin true", tracker.hasCollected("origin") === true);
check("filterAlreadyProvided filters origin", tracker.filterAlreadyProvided(["origin","destination"]).join(",") === "destination");
check("goal still in-progress (not all fields)", tracker.getCurrentGoal()?.status === "in-progress");

tracker.updateCollected({ destination: "LAX", date: "2026-10-01" });
check("all required fields -> completed", tracker.getCurrentGoal()?.status === "completed");

tracker.setGoal("second goal", ["x"]);
check("new goal keeps previous completed (still have 2 goals)", tracker.getGoals().length === 2);
check("previous goal stays completed (not abandoned — it was already done)", tracker.getGoals()[0].status === "completed");
check("new goal in-progress", tracker.getCurrentGoal()?.goal === "second goal");

tracker.applyCorrection({ x: "corrected value" } as any);
check("applyCorrection fills field and completes", tracker.getCurrentGoal()?.status === "completed");

console.log("\n=== TEST: IntentTracker persistence via Session ===");
const session = createSession("goal-persist", new InMemorySessionStore());
const t2 = new IntentTracker({ session });
t2.setGoal("persisted goal", ["a"]);
t2.updateCollected({ a: "1" });
await new Promise(r => setTimeout(r, 20));
const msgs = await session.getMessages();
check("persisted to session (system message)", msgs.some(m => typeof m.content === "string" && (m.content as string).includes("__voice_goal__")));
const t3 = new IntentTracker({ session });
await t3.load();
check("load restores goals from session", t3.getGoals().length >= 1);

if (failures) { console.log(`\n\u274c ${failures} failure(s)`); process.exit(1); }
console.log("\n\uD83C\uDF89 voice-goal-tracking tests passed");
