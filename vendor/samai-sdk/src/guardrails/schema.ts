import type { GuardrailResult, OutputGuardrail } from "../types.js";
import { parseJsonAgainstSchema } from "../json-utils.js";
import type { AnySchema } from "../schema-adapter.js";

export interface SchemaGuardrailOptions {
  /** If true, block on validation failure. If false, allow through with object left undefined. Default: true. */
  strict?: boolean;
}

/**
 * Validates that the model's text output is valid JSON matching the given schema (a zod schema,
 * or any Standard Schema V1 validator such as valibot — see https://standardschema.dev).
 * On success, the parsed object is attached to `result.object`.
 * On failure (strict mode), the call is blocked with a descriptive reason so you can
 * retry with a stricter prompt or a schema-repair pass (see `generateObject()`).
 */
export function createSchemaGuardrail<T>(
  schema: AnySchema<T>,
  options: SchemaGuardrailOptions = {}
): OutputGuardrail {
  const strict = options.strict ?? true;

  return async ({ result }): Promise<GuardrailResult> => {
    const parsed = await parseJsonAgainstSchema(result.text, schema);
    if (!parsed.success) {
      const reason = `Output ${parsed.error}`;
      return strict ? { allowed: false, reason } : { allowed: true };
    }
    return { allowed: true, modifiedResult: { ...result, object: parsed.data } };
  };
}
