import type { Provider } from "../types.js";
import { buildOpenAIStyleProvider } from "./openai-compatible.js";

export interface AzureOpenAIProviderConfig {
  apiKey?: string;
  /** Your Azure resource endpoint, e.g. "https://my-resource.openai.azure.com". */
  endpoint: string;
  /** API version, e.g. "2024-10-21". Defaults to a recent GA version. */
  apiVersion?: string;
}

/**
 * Azure OpenAI Service. Requires the `openai` peer dependency (it ships the `AzureOpenAI`
 * client used here) plus `endpoint` and an API key (falls back to `AZURE_OPENAI_API_KEY`).
 *
 * Azure routes by *deployment name*, not model name — when you define an agent against
 * this provider, pass your deployment name as `model`:
 *
 *   const client = createClient({
 *     provider: azureOpenAI({ endpoint: "https://my-resource.openai.azure.com" }),
 *   });
 *   const agent = defineAgent({ name: "agent", model: "my-gpt4o-deployment", ... });
 */
export function azureOpenAI(config: AzureOpenAIProviderConfig): Provider {
  return buildOpenAIStyleProvider("azure-openai", async () => {
    const { AzureOpenAI } = await import("openai");
    return new AzureOpenAI({
      apiKey: config.apiKey ?? process.env.AZURE_OPENAI_API_KEY,
      endpoint: config.endpoint,
      apiVersion: config.apiVersion ?? "2024-10-21",
    });
  });
}
