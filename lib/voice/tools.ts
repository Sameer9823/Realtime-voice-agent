import { z } from "zod";
// Imported from the `voice` entry, not the package root: the root entry pulls in Node-only modules
// (sandbox, session stores) and cannot be bundled for the browser.
import { defineTool } from "samai-sdk/voice";

/**
 * Browser-side tool stubs.
 *
 * Each stub's only job is to describe the tool to the model and forward the call to
 * `/api/tools/[name]`, where the real implementation runs. Nothing here holds a secret or
 * opens a socket to a third party — that split is what keeps `TAVILY_API_KEY` server-side.
 *
 * The SDK converts these zod schemas to JSON Schema when registering the tool on the
 * realtime session, and runs `execute()` itself when the model calls one, so the result
 * lands back in the live conversation.
 */

/** How long a spoken "yes" stays valid for a side-effecting tool. */
const CONFIRMATION_TTL_MS = 60_000;

/**
 * Tools that asked for confirmation and are waiting on an answer, keyed by tool name.
 *
 * Exists so the second call only succeeds if a first call actually put the question to the
 * user. Without it the model could skip straight to `confirmed: true` and the gate would be
 * decorative.
 */
const pendingConfirmations = new Map<string, number>();

/** Test seam so one test's pending confirmation cannot satisfy another's. */
export function clearPendingConfirmations(): void {
  pendingConfirmations.clear();
}

/** Whether `confirmed` was set may depend on a pending ask; exposed for tests. */
export function hasPendingConfirmation(toolName: string, now = Date.now()): boolean {
  const expiry = pendingConfirmations.get(toolName);
  return expiry !== undefined && expiry > now;
}

interface CallToolOptions {
  name: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

/** POSTs to the server tool route and normalises both outcomes into one shape. */
export async function callTool({ name, args, signal }: CallToolOptions): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`/api/tools/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal,
    });

    const payload = (await response.json().catch(() => null)) as { ok?: boolean; result?: string; error?: string } | null;

    if (!response.ok || !payload?.ok) {
      // The server sends a speakable message; never surface a raw status code to the model.
      return { error: payload?.error ?? `The ${name.replace(/_/g, " ")} tool could not run.` };
    }
    return { result: payload.result };
  } catch {
    return { error: "I couldn't reach the tools server." };
  }
}

/**
 * Runs a tool only if the confirmation gate allows it.
 *
 * `sideEffects: false` goes straight through. `sideEffects: true` takes two calls: the first
 * records the request and tells the model to put the question to the user, the second is
 * accepted only if that first call happened within the TTL.
 */
async function callWithConfirmation(
  name: string,
  sideEffects: boolean,
  confirmed: boolean,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!sideEffects) return callTool({ name, args });

  if (!confirmed) {
    pendingConfirmations.set(name, Date.now() + CONFIRMATION_TTL_MS);
    return {
      needsConfirmation: true,
      message: `Before using ${name.replace(/_/g, " ")}, ask the user for permission and wait for them to agree.`,
    };
  }

  if (!hasPendingConfirmation(name)) {
    return {
      needsConfirmation: true,
      message: `You must ask the user for permission before using ${name.replace(/_/g, " ")}.`,
    };
  }

  pendingConfirmations.delete(name);
  return callTool({ name, args });
}

/**
 * Current information from the web. Read-only, so it runs without asking.
 *
 * Use for anything that may have changed recently: news, prices, releases, today's events.
 */
export const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the web for current information. Use this for news, facts, prices, or anything that may have changed recently. Returns a short summary you can read aloud.",
  parameters: z.object({
    query: z.string().min(1).max(200).describe("What to search for, as a short keyword phrase."),
  }),
  execute: (args) => callTool({ name: "web_search", args }),
});

/** Weather for a city, from a keyless public API. Read-only. */
export const getWeather = defineTool({
  name: "get_weather",
  description:
    "Get the current weather and today's high and low for a city. Use this whenever the user asks about weather, temperature, or a forecast. Give the place as a city name.",
  parameters: z.object({
    location: z.string().min(1).max(100).describe('City name, e.g. "Lisbon" or "Tokyo".'),
  }),
  execute: (args) => callTool({ name: "get_weather", args }),
});

/** This project's own documentation. Read-only. */
export const lookupDocs = defineTool({
  name: "lookup_docs",
  description:
    "Look something up in this project's own documentation. Use this for how-to questions about the product, its configuration, its features, or its pricing. Do not use it for general knowledge.",
  parameters: z.object({
    question: z.string().min(3).max(300).describe("What to look up, phrased as a question."),
  }),
  execute: (args) => callTool({ name: "lookup_docs", args }),
});

/**
 * Reference implementation of the confirmation gate, kept as a factory so the behaviour can
 * be tested against a synthetic side-effecting tool.
 *
 * No production tool is currently side-effecting — search, weather, and docs are all
 * reads — but the gate is wired and tested so adding one is a matter of passing
 * `sideEffects: true` rather than re-architecting the tool loop.
 */
export function createConfirmedTool(options: {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  sideEffects: boolean;
}) {
  return defineTool({
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    execute: (args: Record<string, unknown>) => {
      const { confirmed, ...rest } = args as { confirmed?: boolean };
      return callWithConfirmation(options.name, options.sideEffects, confirmed === true, rest);
    },
  });
}

/** Every tool available to the voice agent during a conversation. */
export const VOICE_TOOLS = [webSearch, getWeather, lookupDocs];