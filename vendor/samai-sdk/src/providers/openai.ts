import type { Provider } from "../types.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseURL?: string;
}

export function openai(config: OpenAIProviderConfig = {}): Provider {
  return createOpenAICompatibleProvider({
    name: "openai",
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}
