import type { Provider } from "../types.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";

export interface MistralProviderConfig {
  apiKey?: string;
  baseURL?: string;
}

/**
 * Mistral's "La Plateforme" API — OpenAI-compatible chat completions endpoint.
 * Get a key at https://console.mistral.ai. Falls back to `MISTRAL_API_KEY` if not passed.
 */
export function mistral(config: MistralProviderConfig = {}): Provider {
  return createOpenAICompatibleProvider({
    name: "mistral",
    apiKey: config.apiKey ?? process.env.MISTRAL_API_KEY,
    baseURL: config.baseURL ?? "https://api.mistral.ai/v1",
  });
}
