import type { AnySchema } from "./schema-adapter.js";
import { validateAgainstSchema } from "./schema-adapter.js";

/** Strips ```json ... ``` or ``` ... ``` fences if the model wrapped its output in them. */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

export type ParseResult<T> = { success: true; data: T } | { success: false; error: string };

/** Extracts JSON from model text and validates it against a zod OR Standard Schema (e.g. valibot) schema. Never throws. */
export async function parseJsonAgainstSchema<T>(text: string, schema: AnySchema<T>): Promise<ParseResult<T>> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(extractJson(text));
  } catch (err) {
    return { success: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  return validateAgainstSchema(schema, parsedJson);
}

/**
 * Best-effort repair of a truncated JSON string: closes any string left open,
 * drops a dangling trailing comma/colon, and closes unclosed `{`/`[` in the
 * right order. This is a heuristic (not a full parser) — good enough to turn
 * a mid-stream chunk like `{"summary": "the batt` into `{"summary": "the batt"}`.
 * Swap for a dedicated partial-JSON package if you need airtight correctness.
 */
function repairPartialJson(input: string): string {
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escapeNext = false;

  for (const ch of input) {
    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (ch === "\\") escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" && stack.at(-1) === "{") stack.pop();
    else if (ch === "]" && stack.at(-1) === "[") stack.pop();
  }

  let out = input;
  if (inString) out += '"';
  out = out.replace(/,\s*$/, "");
  out = out.replace(/:\s*$/, ": null");

  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === "{" ? "}" : "]";
  }
  return out;
}

/**
 * Parses a possibly-incomplete JSON string (e.g. a mid-stream text buffer).
 * Tries a direct parse first; if that fails, attempts a structural repair
 * before giving up. Used by `streamObject()` to emit partial objects as
 * tokens arrive, well before the model has finished.
 */
export function parsePartialJson(text: string): ParseResult<unknown> {
  const candidate = extractJson(text);
  if (!candidate) return { success: false, error: "empty" };

  try {
    return { success: true, data: JSON.parse(candidate) };
  } catch {
    // fall through to repair
  }

  try {
    return { success: true, data: JSON.parse(repairPartialJson(candidate)) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
