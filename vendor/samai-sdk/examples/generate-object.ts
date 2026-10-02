import { z } from "zod";
import { createClient, anthropic, generateObject } from "../src/index.js";

const client = createClient({ provider: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) });

const ReviewSchema = z.object({
  summary: z.string().describe("one-sentence summary of the review"),
  sentiment: z.enum(["positive", "negative", "mixed"]),
  score: z.number().min(1).max(5),
});

const result = await generateObject(client, {
  model: "claude-sonnet-4-6",
  schema: ReviewSchema,
  messages: [
    {
      role: "user",
      content:
        "Extract structured data from this review: 'The battery life is incredible and the screen is gorgeous, " +
        "but the camera really disappoints in low light. Overall I'd say it's a 4 out of 5.'",
    },
  ],
  maxTokens: 300,
});

console.log("Object:", result.object);
console.log("Attempts:", result.attempts);
console.log("Usage:", result.usage);

// TypeScript knows result.object.sentiment is "positive" | "negative" | "mixed"
console.log("Sentiment specifically:", result.object.sentiment);
