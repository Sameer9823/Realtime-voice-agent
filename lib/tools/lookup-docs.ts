import { readFileSync } from "node:fs";
import { z } from "zod";
import type { DocIndex, SearchHit } from "./docs-index";
import { queryIndex } from "./docs-index";
import type { ServerTool } from "./types";

/**
 * Retrieval over the project's own documentation.
 *
 * The index is a committed JSON file, so this tool works in a fresh clone without a build
 * step. Rebuild it with `npm run docs:index` after editing anything in /content.
 */

export interface LookupDocsDeps {
  /** Injected in tests; production loads the committed index once per process. */
  loadIndex?: () => DocIndex;
  /** Max characters of source text handed back. The model reads it aloud. */
  maxChars?: number;
}

const DEFAULT_INDEX_PATH = "content/index.json";

let cached: DocIndex | null = null;

/** Loads the index, memoised for the life of the process. */
export function loadDocsIndex(path = DEFAULT_INDEX_PATH): DocIndex {
  if (!cached) cached = JSON.parse(readFileSync(path, "utf8")) as DocIndex;
  return cached;
}

/** Test seam so a cached index from one test cannot leak into another. */
export function clearDocsIndexCache(): void {
  cached = null;
}

/** Renders hits as a short answer with its source named, so the agent can cite it naturally. */
export function formatHits(hits: SearchHit[], maxChars: number): string {
  if (hits.length === 0) {
    return "I couldn't find anything about that in the documentation.";
  }

  const passages = hits.map((hit, index) => {
    const text = hit.chunk.text.length > maxChars ? `${hit.chunk.text.slice(0, maxChars - 1).trimEnd()}…` : hit.chunk.text;
    return `${index + 1}. From ${hit.chunk.title}, section ${hit.chunk.heading}: ${text}`;
  });

  return `From the documentation. ${passages.join(" ")}`;
}

export function createLookupDocsTool(deps: LookupDocsDeps = {}) {
  return {
    name: "lookup_docs",
    description:
      "Look something up in this project's own documentation. Use this for how-to questions about the product, its configuration, its features, or its pricing. Do not use it for general knowledge.",
    parameters: z.object({
      question: z.string().min(3).max(300).describe("What to look up, phrased as a question."),
    }),
    sideEffects: false,
    async execute({ question }) {
      const maxChars = deps.maxChars ?? 420;
      try {
        const index = deps.loadIndex ? deps.loadIndex() : loadDocsIndex();
        if (!index.chunks?.length) return "The documentation index is empty.";
        return formatHits(queryIndex(index, question), maxChars);
      } catch {
        // Never leak a filesystem path or a JSON parse error into something the model reads aloud.
        return "I couldn't read the documentation just now.";
      }
    },
  } satisfies ServerTool<z.ZodObject<{ question: z.ZodString }>>;
}

export const lookupDocsTool = createLookupDocsTool();