import type { Provider } from "../types.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";

export interface OllamaProviderConfig {
  /** Default: "http://localhost:11434/v1" */
  baseURL?: string;
}

/**
 * Ollama — run models locally, no API key, no per-token cost. Points at Ollama's built-in
 * OpenAI-compatible endpoint (`/v1`), available since Ollama 0.1.26+. Install from
 * https://ollama.com, then `ollama pull llama3.1` (or any model), and pass that model
 * name as `model` in `defineAgent()` / `client.generate()`.
 *
 * Great for local dev/testing an agent's tool-calling and handoff logic for free, before
 * pointing the same agent at a hosted provider for production.
 */
export function ollama(config: OllamaProviderConfig = {}): Provider {
  return createOpenAICompatibleProvider({
    name: "ollama",
    baseURL: config.baseURL ?? "http://localhost:11434/v1",
    requireApiKey: false, // Ollama's OpenAI-compatible endpoint ignores auth entirely
  });
}
