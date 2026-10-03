import { z } from "zod";
import type { ServerTool } from "./types";

/**
 * Web search via Tavily.
 *
 * Tavily is an AI-oriented search API: it returns short answer-ready snippets instead of
 * raw HTML, which matters here because the model has to read the result aloud. Requires
 * `TAVILY_API_KEY`; without it the tool reports itself unavailable rather than throwing,
 * so the agent can say so instead of the turn failing.
 */

const SEARCH_URL = "https://api.tavily.com/search";

/** Kept short on purpose: the model repeats this out loud, and long text reads terribly. */
const MAX_RESULTS = 3;
const MAX_SNIPPET_CHARS = 240;

export interface WebSearchDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string | undefined;
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** Turns the Tavily payload into one or two speakable sentences. */
export function summariseResults(results: Array<{ title?: string; url?: string; content?: string }>): string {
  if (results.length === 0) return "I couldn't find anything on that.";

  const lines = results.slice(0, MAX_RESULTS).map((entry, index) => {
    const title = clip(entry.title ?? "", 80);
    const snippet = clip(entry.content ?? "", MAX_SNIPPET_CHARS);
    const source = entry.url ? ` (${clip(entry.url, 60)})` : "";
    const label = title ? `${title}${source}` : `source ${index + 1}`;
    return `${index + 1}. ${label}: ${snippet}`;
  });

  return `Here's what I found. ${lines.join(" ")}`;
}

export function createWebSearchTool(deps: WebSearchDeps = {}) {
  return {
    name: "web_search",
    description:
      "Search the web for current information. Use this for news, facts, prices, or anything that may have changed recently. Returns a short summary you can read aloud.",
    parameters: z.object({
      query: z.string().min(1).max(200).describe("What to search for, as a short keyword phrase."),
    }),
    sideEffects: false,
    async execute({ query }) {
      const apiKey = deps.apiKey ?? process.env.TAVILY_API_KEY;
      if (!apiKey) return "Web search isn't set up on this server right now.";

      const doFetch = deps.fetchImpl ?? fetch;

      let payload: unknown;
      try {
        const response = await doFetch(SEARCH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, max_results: MAX_RESULTS, include_answer: false }),
          signal: AbortSignal.timeout(8000),
        });

        if (!response.ok) {
          // Deliberately not surfacing the upstream body: it can carry the key or vendor detail.
          return `The search service is unavailable right now.`;
        }
        payload = await response.json();
      } catch {
        return "The search service didn't respond. Please try again.";
      }

      const results = (payload as { results?: Array<{ title?: string; url?: string; content?: string }> }).results;
      if (!Array.isArray(results)) return "The search service returned something I couldn't read.";
      return summariseResults(results);
    },
  } satisfies ServerTool<z.ZodObject<{ query: z.ZodString }>>;
}

export const webSearchTool = createWebSearchTool();