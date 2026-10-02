import { z } from "zod";
import { defineTool, type ToolDefinition } from "../types.js";

export type WebSearchProvider = "tavily" | "brave";

export interface WebSearchToolOptions {
  /**
   * API key for the chosen provider. Falls back to `TAVILY_API_KEY` (for `provider: "tavily"`,
   * the default) or `BRAVE_API_KEY` (for `provider: "brave"`) if not supplied directly.
   */
  apiKey?: string;
  /** Which search API to call. Default: "tavily". */
  provider?: WebSearchProvider;
  /** Max results to return per search. Default: 5. */
  maxResults?: number;
  /** Per-call timeout, in ms. Default: 15000. */
  timeoutMs?: number;
  /** Require the tool call to be human-approved before running. Default: false. */
  requiresApproval?: boolean;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  /** Short excerpt/snippet of the page relevant to the query. */
  snippet: string;
}

const webSearchArgs = z.object({
  query: z.string().min(1).describe("The search query"),
});

async function searchTavily(query: string, apiKey: string, maxResults: number): Promise<WebSearchResultItem[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
  });
  if (!res.ok) {
    throw new Error(`Tavily search failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
  return (data.results ?? []).slice(0, maxResults).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

async function searchBrave(query: string, apiKey: string, maxResults: number): Promise<WebSearchResultItem[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));

  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
  });
  if (!res.ok) {
    throw new Error(`Brave search failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { web?: { results?: { title: string; url: string; description: string }[] } };
  return (data.web?.results ?? []).slice(0, maxResults).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
}

/**
 * Creates a ready-to-use `web_search` tool that a model can call to look up current
 * information. Backed by a real search API (Tavily by default, or Brave) — this makes
 * an actual network request, it isn't a stub. Requires an API key for whichever provider
 * you use; get one at https://tavily.com or https://brave.com/search/api.
 *
 * Usage:
 *   const agent = defineAgent({
 *     name: "researcher",
 *     instructions: "Answer questions using web_search for anything time-sensitive.",
 *     model: "claude-sonnet-4-6",
 *     tools: [createWebSearchTool({ apiKey: process.env.TAVILY_API_KEY })],
 *   });
 */
export function createWebSearchTool(
  options: WebSearchToolOptions = {}
): ToolDefinition<{ query: string }, WebSearchResultItem[]> {
  const provider = options.provider ?? "tavily";
  const maxResults = options.maxResults ?? 5;
  const apiKey =
    options.apiKey ?? (provider === "tavily" ? process.env.TAVILY_API_KEY : process.env.BRAVE_API_KEY);

  return defineTool({
    name: "web_search",
    description:
      "Search the web for current information (news, prices, facts newer than your training data, " +
      "anything time-sensitive). Returns a short list of results with titles, URLs, and snippets.",
    parameters: webSearchArgs,
    timeoutMs: options.timeoutMs ?? 15_000,
    requiresApproval: options.requiresApproval ?? false,
    execute: async ({ query }) => {
      if (!apiKey) {
        throw new Error(
          `web_search tool has no API key configured. Pass { apiKey } to createWebSearchTool(), or set ` +
            `${provider === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY"} in the environment.`
        );
      }
      return provider === "tavily"
        ? searchTavily(query, apiKey, maxResults)
        : searchBrave(query, apiKey, maxResults);
    },
  });
}
