import type { Client } from "./client.js";
import type { GenerateOptions, Message, Usage } from "./types.js";
import { parseJsonAgainstSchema } from "./json-utils.js";
import type { AnySchema } from "./schema-adapter.js";
import { schemaToJsonSchema } from "./schema-adapter.js";

export interface GenerateObjectOptions<T> extends Omit<GenerateOptions, "tools" | "maxToolRoundtrips"> {
  /** A zod schema, or any Standard Schema V1 validator (e.g. valibot 0.31+) — see https://standardschema.dev. */
  schema: AnySchema<T>;
  /** How many repair attempts to make if the model's output fails validation. Default: 2. */
  maxRepairAttempts?: number;
}

export interface GenerateObjectResult<T> {
  object: T;
  /** The raw text the model produced on the successful attempt */
  text: string;
  /** Total usage summed across all attempts, including failed ones */
  usage: Usage;
  /** How many attempts it took (1 = succeeded on the first try) */
  attempts: number;
  raw: unknown;
}

export class GenerateObjectError extends Error {
  constructor(public attempts: number, public lastError: string, public lastText: string) {
    super(`generateObject failed after ${attempts} attempt(s): ${lastError}`);
    this.name = "GenerateObjectError";
  }
}

function sumUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * Generates a response and guarantees it parses into the given schema (zod, or any Standard Schema V1 validator like valibot).
 * If the model's output fails to parse or validate, it's automatically retried
 * with a repair prompt describing the exact error, up to `maxRepairAttempts` times.
 *
 * Works with any provider via the same `client` used for `generate()`/`stream()` —
 * no per-provider JSON-mode wiring needed, since validation happens on our side.
 */
export async function generateObject<T>(
  client: Client,
  options: GenerateObjectOptions<T>
): Promise<GenerateObjectResult<T>> {
  const maxAttempts = (options.maxRepairAttempts ?? 2) + 1;
  const jsonSchema = await schemaToJsonSchema(options.schema);

  const schemaInstruction =
    `Respond with ONLY valid JSON matching this JSON Schema — no prose, no markdown code fences, ` +
    `just the raw JSON object:\n${JSON.stringify(jsonSchema)}`;

  const system = options.system ? `${options.system}\n\n${schemaInstruction}` : schemaInstruction;

  let messages: Message[] = options.messages;
  let cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let lastText = "";
  let lastError = "";
  let lastRaw: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await client.generate({
      ...options,
      system,
      messages,
      tools: undefined,
      maxToolRoundtrips: undefined,
    });

    cumulativeUsage = sumUsage(cumulativeUsage, result.usage);
    lastText = result.text;
    lastRaw = result.raw;

    const parsed = await parseJsonAgainstSchema(result.text, options.schema);
    if (parsed.success) {
      return { object: parsed.data, text: result.text, usage: cumulativeUsage, attempts: attempt, raw: lastRaw };
    }

    lastError = parsed.error;
    if (attempt === maxAttempts) break;

    // Feed the bad output + the exact validation error back for a repair pass
    messages = [
      ...messages,
      { role: "assistant", content: result.text },
      {
        role: "user",
        content: `That output ${parsed.error}. Return corrected JSON only, matching the schema exactly.`,
      },
    ];
  }

  throw new GenerateObjectError(maxAttempts, lastError, lastText);
}
