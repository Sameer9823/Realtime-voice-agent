/**
 * Server-side tool contract.
 *
 * Every tool that touches the network or the filesystem runs behind this contract on the
 * server. The browser never receives these implementations — it gets a thin client stub
 * in `lib/voice/tools.ts` that POSTs to `/api/tools/[name]`. That split is the whole
 * point: a browser-side tool would expose `TAVILY_API_KEY` to anyone with devtools.
 */
import type { z } from "zod";

/**
 * A tool the server can execute.
 *
 * `sideEffects` is the confirmation gate. Read-only tools return false and run
 * immediately. Anything that changes state or spends money on the user's behalf must be
 * true, which makes the agent ask "Should I go ahead?" and wait for a spoken yes.
 */
export interface ServerTool<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Wire name, matching the `[name]` route segment and the client stub. */
  name: string;
  /** Told to the model verbatim, so it reads as spoken guidance. */
  description: string;
  /** zod schema; the model sees its JSON Schema form. */
  parameters: TParams;
  /**
   * When true the agent must obtain an explicit spoken yes before calling this. Kept on
   * the definition rather than inferred, because "does this tool have side effects" is a
   * judgement call about the world, not something derivable from the signature.
   */
  sideEffects: boolean;
  execute(args: z.infer<TParams>): Promise<string>;
}

/** What a tool route returns. `ok: false` carries a message safe to speak aloud. */
export type ToolResult = { ok: true; result: string } | { ok: false; error: string };