import { z } from "zod";
import { toBedrockMessages, toBedrockTools } from "../src/providers/bedrock.js";
import { defineTool } from "../src/index.js";
import type { Message } from "../src/types.js";

// ===========================================================================
// TEST 1 — toBedrockTools(): zod schema -> Bedrock toolSpec shape
// ===========================================================================
console.log("=== TEST 1: toBedrockTools() ===");

const getWeather = defineTool({
  name: "get_weather",
  description: "Get the weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `sunny in ${city}`,
});

const bedrockTools = toBedrockTools([getWeather]);
console.log(`  tools[0].toolSpec.name: "${bedrockTools.tools[0].toolSpec.name}" (expected "get_weather")`);
if (bedrockTools.tools[0].toolSpec.name !== "get_weather") throw new Error("Tool name not converted correctly");
if (bedrockTools.tools[0].toolSpec.description !== "Get the weather for a city") {
  throw new Error("Tool description not converted correctly");
}
if (!bedrockTools.tools[0].toolSpec.inputSchema?.json) throw new Error("inputSchema.json missing");
console.log("  inputSchema.json present with converted zod schema: true");

const noTools = toBedrockTools([]);
console.log(`  toBedrockTools([]) returns undefined: ${noTools === undefined}`);
if (noTools !== undefined) throw new Error("Empty tool list should convert to undefined, not an empty toolConfig");

console.log("✅ TEST 1 passed\n");

// ===========================================================================
// TEST 2 — toBedrockMessages(): every content-part type converts to the right
// Converse API content block shape
// ===========================================================================
console.log("=== TEST 2: toBedrockMessages() content block conversion ===");

const messages: Message[] = [
  { role: "user", content: "plain string message" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me check that." },
      { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", args: { city: "Tokyo" } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call_1", toolName: "get_weather", result: "18C and cloudy", isError: false }],
  },
  {
    role: "user",
    content: [
      { type: "text", text: "what about this image?" },
      { type: "image", image: "aGVsbG8=", mimeType: "image/png" },
    ],
  },
];

const bedrockMsgs = toBedrockMessages(messages);
console.log(`  message count: ${bedrockMsgs.length} (expected 4)`);
if (bedrockMsgs.length !== 4) throw new Error("Wrong number of converted messages");

console.log(`  [0] plain string -> role "${bedrockMsgs[0].role}", content: ${JSON.stringify(bedrockMsgs[0].content)}`);
if (bedrockMsgs[0].role !== "user" || bedrockMsgs[0].content[0].text !== "plain string message") {
  throw new Error("Plain string message conversion is wrong");
}

const assistantBlock = bedrockMsgs[1];
console.log(`  [1] assistant tool-call -> role "${assistantBlock.role}", blocks: ${assistantBlock.content.length}`);
if (assistantBlock.role !== "assistant") throw new Error("Assistant role not preserved");
const toolUseBlock = assistantBlock.content.find((b: any) => b.toolUse);
if (!toolUseBlock) throw new Error("tool-call did not convert to a toolUse block");
if (toolUseBlock.toolUse.toolUseId !== "call_1" || toolUseBlock.toolUse.name !== "get_weather") {
  throw new Error("toolUse block fields are wrong");
}
if (JSON.stringify(toolUseBlock.toolUse.input) !== JSON.stringify({ city: "Tokyo" })) {
  throw new Error("toolUse input args not preserved");
}

const toolResultBlock = bedrockMsgs[2];
console.log(`  [2] tool role -> converted to Converse role "${toolResultBlock.role}" (Bedrock has no "tool" role, must be "user")`);
if (toolResultBlock.role !== "user") throw new Error('tool role must map to "user" for the Converse API');
const trBlock = toolResultBlock.content.find((b: any) => b.toolResult);
if (!trBlock) throw new Error("tool-result did not convert to a toolResult block");
if (trBlock.toolResult.toolUseId !== "call_1") throw new Error("toolResult toolUseId not preserved");
if (trBlock.toolResult.status !== "success") throw new Error("toolResult status should be 'success' when isError is false");
if (trBlock.toolResult.content[0].text !== "18C and cloudy") throw new Error("toolResult content text not preserved");

const imageMsg = bedrockMsgs[3];
const imgBlock = imageMsg.content.find((b: any) => b.image);
console.log(`  [3] image part -> format "${imgBlock?.image?.format}" (expected "png")`);
if (!imgBlock) throw new Error("image part did not convert to an image block");
if (imgBlock.image.format !== "png") throw new Error("image format not derived correctly from mimeType");
if (imgBlock.image.source.bytes !== "aGVsbG8=") throw new Error("image bytes not preserved");

// isError: true should map to status "error"
const errMsgs = toBedrockMessages([
  { role: "tool", content: [{ type: "tool-result", toolCallId: "x", toolName: "t", result: "boom", isError: true }] },
]);
const errBlock = errMsgs[0].content.find((b: any) => b.toolResult);
console.log(`  isError: true -> toolResult.status: "${errBlock.toolResult.status}" (expected "error")`);
if (errBlock.toolResult.status !== "error") throw new Error("isError: true should map to status 'error'");

// system messages should be filtered out (Converse API takes `system` as a separate top-level field)
const withSystem = toBedrockMessages([{ role: "system", content: "ignored" }, { role: "user", content: "hi" }]);
console.log(`  system messages filtered out: ${withSystem.length === 1 && withSystem[0].role === "user"}`);
if (withSystem.length !== 1) throw new Error("system-role messages must be filtered out of the messages array");

console.log("✅ TEST 2 passed\n");

// ===========================================================================
// TEST 3 — every new provider factory constructs correctly (name set right,
// optional-key providers don't throw just from being constructed)
// ===========================================================================
console.log("=== TEST 3: new provider factories construct correctly ===");

const { groq } = await import("../src/providers/groq.js");
const { mistral } = await import("../src/providers/mistral.js");
const { ollama } = await import("../src/providers/ollama.js");
const { azureOpenAI } = await import("../src/providers/azure-openai.js");
const { bedrock } = await import("../src/providers/bedrock.js");

const groqProvider = groq({ apiKey: "test-key" });
console.log(`  groq().name: "${groqProvider.name}" (expected "groq")`);
if (groqProvider.name !== "groq") throw new Error("groq() provider name is wrong");

const mistralProvider = mistral({ apiKey: "test-key" });
console.log(`  mistral().name: "${mistralProvider.name}" (expected "mistral")`);
if (mistralProvider.name !== "mistral") throw new Error("mistral() provider name is wrong");

const ollamaProvider = ollama(); // no key at all — must not throw
console.log(`  ollama().name (no apiKey given): "${ollamaProvider.name}" (expected "ollama")`);
if (ollamaProvider.name !== "ollama") throw new Error("ollama() provider name is wrong");

const azureProvider = azureOpenAI({ endpoint: "https://example.openai.azure.com" });
console.log(`  azureOpenAI().name: "${azureProvider.name}" (expected "azure-openai")`);
if (azureProvider.name !== "azure-openai") throw new Error("azureOpenAI() provider name is wrong");

const bedrockProvider = bedrock({ region: "us-east-1" });
console.log(`  bedrock().name: "${bedrockProvider.name}" (expected "bedrock")`);
if (bedrockProvider.name !== "bedrock") throw new Error("bedrock() provider name is wrong");

// Every provider exposes the same generate/stream shape regardless of backend.
for (const p of [groqProvider, mistralProvider, ollamaProvider, azureProvider, bedrockProvider]) {
  if (typeof p.generate !== "function" || typeof p.stream !== "function") {
    throw new Error(`Provider "${p.name}" does not satisfy the Provider interface`);
  }
}
console.log("  all 5 providers satisfy the Provider interface (generate + stream present): true");

console.log("✅ TEST 3 passed\n");

// ===========================================================================
// TEST 4 — promptCaching: Anthropic cache_control breakpoints are added
// correctly (and NOT added when promptCaching is off)
// ===========================================================================
console.log("=== TEST 4: Anthropic prompt-caching conversion ===");

const { toAnthropicSystem, toAnthropicTools } = await import("../src/providers/anthropic.js");

const plainSystem = toAnthropicSystem("You are a helpful assistant.", false);
console.log(`  promptCaching: false -> system is a plain string: ${typeof plainSystem === "string"}`);
if (typeof plainSystem !== "string") throw new Error("Without promptCaching, system should stay a plain string");

const cachedSystem = toAnthropicSystem("You are a helpful assistant.", true);
console.log(`  promptCaching: true -> system is an array with cache_control: ${Array.isArray(cachedSystem)}`);
if (!Array.isArray(cachedSystem)) throw new Error("With promptCaching, system should become an array of blocks");
if (cachedSystem[0].cache_control?.type !== "ephemeral") throw new Error("cache_control not set on the system block");
if (cachedSystem[0].text !== "You are a helpful assistant.") throw new Error("System text not preserved when caching");

const uncachedTools = toAnthropicTools([getWeather], false)!;
console.log(`  promptCaching: false -> no cache_control on tools: ${(uncachedTools[0] as any).cache_control === undefined}`);
if ((uncachedTools[0] as any).cache_control !== undefined) throw new Error("Tools should not have cache_control when promptCaching is off");

const cachedTools = toAnthropicTools([getWeather], true)!;
console.log(`  promptCaching: true -> cache_control on last tool: ${(cachedTools.at(-1) as any).cache_control?.type === "ephemeral"}`);
if ((cachedTools.at(-1) as any).cache_control?.type !== "ephemeral") throw new Error("cache_control not set on the last tool");
// Only the LAST tool gets the breakpoint — that's what makes the whole prefix up to it cacheable as one unit.
if (cachedTools.length > 1 && (cachedTools[0] as any).cache_control !== undefined) {
  throw new Error("cache_control should only be on the LAST tool, not earlier ones");
}

const noSystem = toAnthropicSystem(undefined, true);
console.log(`  no system prompt -> returns undefined even with caching on: ${noSystem === undefined}`);
if (noSystem !== undefined) throw new Error("undefined system should stay undefined regardless of caching");

console.log("✅ TEST 4 passed\n");

console.log("🎉 All provider-conversion tests passed");
