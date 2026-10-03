import { lookupDocsTool } from "./lookup-docs";
import type { ServerTool } from "./types";
import { webSearchTool } from "./web-search";
import { weatherTool } from "./weather";

/**
 * Every tool the server can execute, keyed by the `[name]` route segment.
 *
 * The browser stub in `lib/voice/tools.ts` and this registry are kept in step by
 * `TOOL_NAMES`, which both sides import, so a tool cannot exist on one side only.
 */

export const TOOLS: ServerTool[] = [webSearchTool, weatherTool, lookupDocsTool];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name) as ReadonlyArray<string>;

export type ToolName = (typeof TOOLS)[number]["name"];

export function findTool(name: string): ServerTool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}