import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ParseResult } from "./json-utils.js";

/**
 * The Standard Schema V1 interface (https://standardschema.dev) — a shared shape that zod
 * (3.24+), valibot (0.31+), arktype, and others implement so validation libraries can accept
 * "any schema" without hard-coupling to one. We don't depend on any of those packages to define
 * this — it's copied structurally from the spec so `generateObject()`/`streamObject()`/tool
 * output validation can accept a valibot schema without valibot being a required dependency.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> }
        >;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

/** Accepted anywhere the SDK previously required a zod schema: a zod schema, OR any Standard Schema V1 validator (valibot, arktype, etc). */
export type AnySchema<T = unknown> = z.ZodType<T> | StandardSchemaV1<unknown, T>;

function isZodSchema(schema: unknown): schema is z.ZodType {
  return (
    typeof schema === "object" &&
    schema !== null &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function" &&
    typeof (schema as { _def?: unknown })._def === "object"
  );
}

function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
  return typeof schema === "object" && schema !== null && "~standard" in schema;
}

/** Validates `value` against a zod OR Standard Schema V1 schema. Never throws — mirrors `parseJsonAgainstSchema`'s contract. */
export async function validateAgainstSchema<T>(schema: AnySchema<T>, value: unknown): Promise<ParseResult<T>> {
  if (isZodSchema(schema)) {
    const result = schema.safeParse(value);
    return result.success ? { success: true, data: result.data as T } : { success: false, error: `failed schema validation: ${result.error.message}` };
  }

  if (isStandardSchema(schema)) {
    const result = await schema["~standard"].validate(value);
    if (!result.issues) return { success: true, data: result.value as T };
    const message = result.issues.map((issue) => issue.message).join("; ");
    return { success: false, error: `failed schema validation: ${message}` };
  }

  throw new Error(
    "Unsupported schema passed to samai-sdk — expected a zod schema or a Standard Schema V1 validator " +
      "(e.g. valibot 0.31+, arktype). See https://standardschema.dev for the interface."
  );
}

/**
 * Resolves the JSON Schema a provider should send to the model for a tool's parameters.
 * If the tool carries `rawJsonSchema` (set on tools pulled from an MCP server — see `mcp.ts`
 * — whose schema is already JSON Schema, not zod), that's used as-is. Otherwise falls back to
 * converting `parameters` via `zod-to-json-schema`, same as before this existed.
 */
export function toolParametersJsonSchema(tool: { parameters: z.ZodType; rawJsonSchema?: unknown }): unknown {
  if (tool.rawJsonSchema !== undefined) return tool.rawJsonSchema;
  return zodToJsonSchema(tool.parameters, { target: "openApi3" });
}

/**
 * Converts a schema to a JSON Schema object for embedding in the "respond with JSON matching
 * this shape" instruction sent to the model. Zod schemas go through `zod-to-json-schema`
 * (unchanged from before). For a Standard Schema validator, we currently only know how to do
 * this for valibot specifically, via the optional `@valibot/to-json-schema` package — install it
 * if you're using valibot schemas with `generateObject()`/`streamObject()`. Other Standard Schema
 * vendors (arktype, etc.) can still be used for *validation* (`validateAgainstSchema()`), just
 * not for auto-generating the model-facing JSON Schema instruction — pass your own `system`
 * prompt describing the shape instead.
 */
export async function schemaToJsonSchema(schema: AnySchema): Promise<unknown> {
  if (isZodSchema(schema)) {
    return zodToJsonSchema(schema, { target: "openApi3" });
  }

  if (isStandardSchema(schema)) {
    const vendor = schema["~standard"].vendor;
    if (vendor === "valibot") {
      try {
        const { toJsonSchema } = await import("@valibot/to-json-schema");
        return toJsonSchema(schema as never);
      } catch (err) {
        throw new Error(
          `Converting a valibot schema to JSON Schema requires the optional "@valibot/to-json-schema" package. ` +
            `Install it with \`npm install @valibot/to-json-schema\`. (Underlying error: ${err instanceof Error ? err.message : String(err)})`
        );
      }
    }
    throw new Error(
      `samai-sdk doesn't know how to convert a "${vendor}" Standard Schema to JSON Schema for the model instruction yet ` +
        `(only zod and valibot are supported for this). Pass a zod or valibot schema, or supply your own \`system\` prompt describing the output shape.`
    );
  }

  throw new Error("Unsupported schema passed to samai-sdk — expected a zod schema or a Standard Schema V1 validator.");
}
