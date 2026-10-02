import { z } from "zod";
import { createClient, defineTool, openai, anthropic, google } from "../src/index.js";

// One tool definition, works identically across every provider.
const getWeather = defineTool({
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => {
    return { city, tempC: 28, condition: "sunny" }; // stub — plug in a real API
  },
});

async function run(providerName: "openai" | "anthropic" | "google") {
  const provider =
    providerName === "openai"
      ? openai({ apiKey: process.env.OPENAI_API_KEY })
      : providerName === "anthropic"
      ? anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : google({ apiKey: process.env.GOOGLE_API_KEY });

  const model =
    providerName === "openai" ? "gpt-4o-mini" : providerName === "anthropic" ? "claude-sonnet-4-6" : "gemini-2.0-flash";

  const client = createClient({ provider });

  const result = await client.generate({
    model,
    system: "You are a concise assistant.",
    messages: [{ role: "user", content: "What's the weather in Chennai? Use the tool." }],
    tools: [getWeather],
    maxToolRoundtrips: 2,
    maxTokens: 300,
  });

  console.log(`\n--- ${providerName} ---`);
  console.log("Text:", result.text);
  console.log("Finish reason:", result.finishReason);
  console.log("Usage:", result.usage);
}

// Run whichever providers you have API keys for
await run("anthropic").catch((e) => console.error("anthropic failed:", e.message));
