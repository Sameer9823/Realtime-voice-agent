import { z } from "zod";
import {
  createClient,
  anthropic,
  defineAgent,
  runAgentStream,
  createSession,
  InMemorySessionStore,
} from "../src/index.js";

const client = createClient({ provider: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) });

const getWeather = {
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }: { city: string }) => `18C and cloudy in ${city}`,
};

const packingAgent = defineAgent({
  name: "packing_specialist",
  instructions:
    "You give concise packing advice for trips, based on whatever weather information " +
    "you've already been given in the conversation. Don't ask for weather again — use what's there.",
  model: "claude-sonnet-4-6",
});

const routerAgent = defineAgent({
  name: "trip_router",
  instructions:
    "You help with trip planning. If the user asks what to pack, first look up the weather " +
    "for their destination with get_weather, then hand off to packing_specialist for the actual advice.",
  model: "claude-sonnet-4-6",
  tools: [getWeather],
  handoffs: [packingAgent],
});

// A session persists conversation history across separate runAgentStream() calls —
// swap InMemorySessionStore for FileSessionStore(dir) to survive process restarts.
const session = createSession("demo-user-123", new InMemorySessionStore());

for await (const event of runAgentStream(client, routerAgent, "What should I pack for a trip to Tokyo?", { session })) {
  switch (event.type) {
    case "run-started":
      console.log(`[run ${event.runId}] started with agent "${event.agentName}"`);
      break;
    case "tool-started":
      console.log(`  -> calling tool: ${event.toolName}`, event.args);
      break;
    case "tool-completed":
      console.log(`  <- tool result:`, event.result);
      break;
    case "handoff-started":
      console.log(`  >> handing off: ${event.fromAgent} -> ${event.toAgent} (${event.reason})`);
      break;
    case "text-delta":
      process.stdout.write(event.textDelta);
      break;
    case "run-completed":
      console.log(`\n[done] usage:`, event.usage);
      break;
    case "run-failed":
      console.error(`[failed]`, event.error);
      break;
  }
}
