import { effectScope, nextTick, watch } from "vue";
import { createClient, defineAgent, defineTool } from "../src/index.js";
import { z } from "zod";
import { useAgent } from "../src/vue.js";
import { createMockProvider } from "../src/testing.js";

// ===========================================================================
// TEST 1 — useAgent() drives a real run and Vue's reactivity system actually
// reacts to it (watch() callbacks fire), not just "the values end up right"
// ===========================================================================
console.log("=== TEST 1: useAgent() (Vue) — reactive refs update live during a run ===");

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

const scope = effectScope();
const textUpdates: string[] = [];
const isRunningUpdates: boolean[] = [];

let composableResult!: ReturnType<typeof useAgent>;
scope.run(() => {
  composableResult = useAgent(client, agent);
  watch(composableResult.text, (v) => textUpdates.push(v));
  watch(composableResult.isRunning, (v) => isRunningUpdates.push(v));
});

const result = await composableResult.run("What's the weather in Tokyo?");
await nextTick();

console.log(`  watch() on isRunning actually fired (true then false): ${JSON.stringify(isRunningUpdates)}`);
if (isRunningUpdates.length < 2 || isRunningUpdates[0] !== true || isRunningUpdates.at(-1) !== false) {
  throw new Error("Vue's reactivity system should have observed isRunning flip true then false, not just the final value");
}

console.log(`  watch() on text actually fired with the final text: ${textUpdates.at(-1) === "It's 18°C and cloudy in Tokyo."}`);
if (textUpdates.at(-1) !== "It's 18°C and cloudy in Tokyo.") {
  throw new Error("Vue's reactivity system should have observed the text ref update, not just the final value");
}

console.log(`  isRunning went true -> false: ${composableResult.isRunning.value === false}`);
if (composableResult.isRunning.value !== false) throw new Error("isRunning should be false after the run completes");

console.log(`  text.value: "${composableResult.text.value}" (expected the final answer)`);
if (composableResult.text.value !== "It's 18°C and cloudy in Tokyo.") throw new Error("text ref should hold the streamed text");

console.log(`  events.value recorded ${composableResult.events.value.length} events (expected > 0)`);
if (composableResult.events.value.length === 0) throw new Error("events ref should accumulate AgentEvents");

console.log(`  result.value.output matches run()'s return value: ${composableResult.result.value?.output === result?.output}`);
if (composableResult.result.value?.output !== result?.output) throw new Error("result ref should match the resolved run result");

console.log(`  error.value is null on a successful run: ${composableResult.error.value === null}`);
if (composableResult.error.value !== null) throw new Error("error ref should stay null on success");

scope.stop();
console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — error path sets error.value and leaves result.value null; reset()
// clears everything back to idle
// ===========================================================================
console.log("=== TEST 2: useAgent() (Vue) — error path + reset() ===");

const erroringMock = createMockProvider({ responses: [{ error: new Error("simulated provider outage") }] });
const erroringClient = createClient({ provider: erroringMock });

const errScope = effectScope();
let errState!: ReturnType<typeof useAgent>;
errScope.run(() => {
  errState = useAgent(erroringClient, agent);
});

const errResult = await errState.run("hi");
console.log(`  run() resolves to undefined on failure: ${errResult === undefined}`);
if (errResult !== undefined) throw new Error("run() should resolve to undefined when the underlying call throws");

console.log(`  error.value is set: ${errState.error.value instanceof Error}`);
if (!(errState.error.value instanceof Error)) throw new Error("error ref should be set after a failed run");

console.log(`  result.value stays null: ${errState.result.value === null}`);
if (errState.result.value !== null) throw new Error("result ref should stay null after a failed run");

errState.reset();
console.log(`  reset() clears error/text/events back to idle: ${errState.error.value === null && errState.text.value === "" && errState.events.value.length === 0}`);
if (errState.error.value !== null || errState.text.value !== "" || errState.events.value.length !== 0) {
  throw new Error("reset() should return all refs to their initial idle state");
}

errScope.stop();
console.log("✅ TEST 2 passed\n");

console.log("🎉 All Vue useAgent() tests passed");
