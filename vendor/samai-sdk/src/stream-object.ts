import type { Client } from "./client.js";
import type { DeepPartial, GenerateOptions, Usage } from "./types.js";
import { parseJsonAgainstSchema, parsePartialJson } from "./json-utils.js";
import type { AnySchema } from "./schema-adapter.js";
import { schemaToJsonSchema } from "./schema-adapter.js";
import { GenerateObjectError } from "./generate-object.js";

export interface StreamObjectOptions<T> extends Omit<GenerateOptions, "tools" | "maxToolRoundtrips"> {
  /** A zod schema, or any Standard Schema V1 validator (e.g. valibot 0.31+) — see https://standardschema.dev. */
  schema: AnySchema<T>;
}

export interface StreamObjectResult<T> {
  /**
   * Async iterable of progressively-more-complete partial objects as JSON
   * streams in from the model. Each item is validated against your schema
   * loosely (fields may be missing/partial) — only the final `object` is
   * guaranteed to fully satisfy it.
   */
  partialObjectStream: AsyncIterable<DeepPartial<T>>;
  /** Resolves to the final, schema-validated object once the stream finishes. */
  object: Promise<T>;
  /** Resolves once the stream finishes. */
  usage: Promise<Usage>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A minimal push-based async queue so we can start consuming the provider stream immediately, independent of whether/when the caller reads partialObjectStream. */
function createAsyncQueue<T>() {
  const buffered: T[] = [];
  let waiting: ((result: IteratorResult<T>) => void) | null = null;
  let closed = false;
  let closeError: unknown = null;

  function push(item: T) {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: item, done: false });
    } else {
      buffered.push(item);
    }
  }

  function finish(error?: unknown) {
    closed = true;
    closeError = error ?? null;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffered.length > 0) {
            return Promise.resolve({ value: buffered.shift() as T, done: false });
          }
          if (closed) {
            if (closeError) return Promise.reject(closeError);
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      };
    },
  };

  return { push, finish, iterable };
}

/**
 * Streams a structured object as the model generates it: `partialObjectStream`
 * yields progressively-more-complete partial objects (useful for filling in a
 * form or card in a UI as tokens arrive), while `object` resolves to the final,
 * fully schema-validated result once the stream completes.
 *
 * Unlike `generateObject()`, this does NOT auto-repair invalid output — once a
 * stream starts emitting to the caller, silently restarting it would duplicate
 * or drop what they've already seen (same tradeoff documented for retries/
 * fallback + streaming). If the final accumulated text fails schema validation,
 * `object` rejects with a `GenerateObjectError` (attempts: 1).
 *
 * Works across all three providers — validation happens on our side (zod or a Standard Schema validator like valibot).
 */
export function streamObject<T>(client: Client, options: StreamObjectOptions<T>): StreamObjectResult<T> {
  const queue = createAsyncQueue<DeepPartial<T>>();
  const objectDeferred = createDeferred<T>();
  const usageDeferred = createDeferred<Usage>();

  (async () => {
    let accumulatedText = "";
    let lastEmitted: string | null = null;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    try {
      const jsonSchema = await schemaToJsonSchema(options.schema);
      const schemaInstruction =
        `Respond with ONLY valid JSON matching this JSON Schema — no prose, no markdown code fences, ` +
        `just the raw JSON object:\n${JSON.stringify(jsonSchema)}`;
      const system = options.system ? `${options.system}\n\n${schemaInstruction}` : schemaInstruction;

      for await (const chunk of client.stream({
        ...options,
        system,
        tools: undefined,
        maxToolRoundtrips: undefined,
      })) {
        if (chunk.type === "text-delta") {
          accumulatedText += chunk.textDelta;

          const partial = parsePartialJson(accumulatedText);
          if (partial.success) {
            const serialized = JSON.stringify(partial.data);
            // Skip emitting if this chunk's repaired JSON parses to the same
            // shape as the last emit (common when a delta lands mid-token).
            if (serialized !== lastEmitted) {
              lastEmitted = serialized;
              queue.push(partial.data as DeepPartial<T>);
            }
          }
        } else if (chunk.type === "finish") {
          usage = chunk.usage;
        } else if (chunk.type === "error") {
          throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
        }
      }

      const finalParse = await parseJsonAgainstSchema(accumulatedText, options.schema);
      if (!finalParse.success) {
        throw new GenerateObjectError(1, finalParse.error, accumulatedText);
      }

      queue.finish();
      objectDeferred.resolve(finalParse.data);
      usageDeferred.resolve(usage);
    } catch (err) {
      queue.finish(err);
      objectDeferred.reject(err);
      usageDeferred.reject(err);
    }
  })();

  return {
    partialObjectStream: queue.iterable,
    object: objectDeferred.promise,
    usage: usageDeferred.promise,
  };
}
