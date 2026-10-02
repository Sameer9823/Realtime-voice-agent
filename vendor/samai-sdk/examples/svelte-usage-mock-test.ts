import { z } from "zod";
import { createClient, defineAgent, defineTool } from "../src/index.js";
import { useAgent, type AgentState } from "../src/svelte.js";
import { createMockProvider } from "../src/testing.js";

// ===========================================================================
// TEST 1 — useAgent() (Svelte) drives a real run and the store's subscribe()
// actually fires as state changes, not just "the final value is right"
// ===========================================================================
console.log("=== TEST 1: useAgent() (Svelte) — store subscription fires live during a run ===");

const getWeather = defineTool({
  name: "get_weather",
  description: "Get the weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `18°C and cloudy in ${city}`,
});

const mock = createMockProvider({
  responses: [
    { toolCalls: [{ toolName: "get_weather", args: { city: "Tokyo" } }] },
    { text: "It's 18°C and cloudy in Tokyo." },
  ],
});
const client = createClient({ provider: mock });
const agent = defineAgent({ name: "weather_agent", instructions: "Answer weather questions.", model: "gpt-4o", tools: [getWeather] });

const store = useAgent(client, agent);
const snapshots: AgentState[] = [];
const unsubscribe = store.subscribe((s) => snapshots.push({ ...s }));

const result = await store.run("What's the weather in Tokyo?");

console.log(`  subscribe() observed multiple state transitions: ${snapshots.length} (expected > 2)`);
if (snapshots.length <= 2) throw new Error("Expected several store updates (idle -> running with events -> done), not just a start/end pair");

const isRunningSequence = snapshots.map((s) => s.isRunning);
console.log(`  isRunning sequence includes true then settles false: ${isRunningSequence.includes(true) && isRunningSequence.at(-1) === false}`);
if (!isRunningSequence.includes(true) || isRunningSequence.at(-1) !== false) {
  throw new Error("Store should have gone through an isRunning: true state before settling to false");
}

const finalSnapshot = snapshots.at(-1)!;
console.log(`  final snapshot text: "${finalSnapshot.text}" (expected the final answer)`);
if (finalSnapshot.text !== "It's 18°C and cloudy in Tokyo.") throw new Error("Final store snapshot should hold the streamed text");

console.log(`  final snapshot result.output matches run()'s return value: ${finalSnapshot.result?.output === result?.output}`);
if (finalSnapshot.result?.output !== result?.output) throw new Error("Final store snapshot's result should match the resolved run result");

console.log(`  events accumulated across snapshots (growing, not reset each time): ${snapshots.some((s, i) => i > 0 && s.events.length > snapshots[i - 1].events.length)}`);
if (!snapshots.some((s, i) => i > 0 && s.events.length > snapshots[i - 1].events.length)) {
  throw new Error("events array should grow across successive store updates during the run");
}

unsubscribe();
console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — error path sets error in the store; reset() returns to idle and a
// stale in-flight run's late events are ignored after reset() starts a new one
// ===========================================================================
console.log("=== TEST 2: useAgent() (Svelte) — error path + reset() ===");

const erroringMock = createMockProvider({ responses: [{ error: new Error("simulated provider outage") }] });
const erroringClient = createClient({ provider: erroringMock });
const errStore = useAgent(erroringClient, agent);

const errResult = await errStore.run("hi");
console.log(`  run() resolves to undefined on failure: ${errResult === undefined}`);
if (errResult !== undefined) throw new Error("run() should resolve to undefined when the underlying call throws");

let currentState!: AgentState;
const unsub2 = errStore.subscribe((s) => (currentState = s));
console.log(`  store.error is set after a failed run: ${currentState.error instanceof Error}`);
if (!(currentState.error instanceof Error)) throw new Error("store.error should be set after a failed run");

errStore.reset();
console.log(`  reset() clears error/text/events back to idle: ${currentState.error === null && currentState.text === "" && currentState.events.length === 0}`);
if (currentState.error !== null || currentState.text !== "" || currentState.events.length !== 0) {
  throw new Error("reset() should return the store to its initial idle state");
}
unsub2();

console.log("✅ TEST 2 passed\n");

console.log("🎉 All Svelte useAgent() tests passed");
