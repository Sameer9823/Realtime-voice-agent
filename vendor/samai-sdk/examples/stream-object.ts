import { z } from "zod";
import { createClient, anthropic, streamObject } from "../src/index.js";

const client = createClient({ provider: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) });

const RecipeSchema = z.object({
  title: z.string(),
  servings: z.number(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
});

const { partialObjectStream, object, usage } = streamObject(client, {
  model: "claude-sonnet-4-6",
  schema: RecipeSchema,
  messages: [{ role: "user", content: "Give me a simple recipe for chana masala." }],
  maxTokens: 500,
});

// Render progressively — e.g. this is what you'd bind to React state to fill
// in a recipe card field-by-field as the model writes it.
for await (const partial of partialObjectStream) {
  console.clear();
  console.log("Recipe so far:", partial);
}

console.log("\nFinal, schema-validated object:", await object);
console.log("Usage:", await usage);
