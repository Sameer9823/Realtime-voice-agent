import type { Provider } from "../types.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";

export interface GroqProviderConfig {
  apiKey?: string;
  baseURL?: string;
}

/**
 * Groq — OpenAI-compatible endpoint, notable mainly for very fast inference (LPU hardware).
 * Get a key at https://console.groq.com/keys. Falls back to `GROQ_API_KEY` if not passed.
 */
export function groq(config: GroqProviderConfig = {}): Provider {
  return createOpenAICompatibleProvider({
    name: "groq",
    apiKey: config.apiKey ?? process.env.GROQ_API_KEY,
    baseURL: config.baseURL ?? "https://api.groq.com/openai/v1",
  });
}
