const SECRET_KEY_PATTERN =
  /(api[-_]?key|apikey|secret|passwd|password|token|authorization|cookie|credential|private[-_]?key)/i;

const MAX_STRING_LENGTH = 500;
const KEEP_PREFIX = 200;

export function redactValue(value: unknown, keyName?: string): unknown {
  if (keyName && SECRET_KEY_PATTERN.test(keyName)) return "[redacted]";
  if (typeof value === "string") return truncate(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") return redactObject(value as Record<string, unknown>);
  return value;
}

export function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactValue(value, key);
  }
  return output;
}

export function truncate(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, KEEP_PREFIX)}…[truncated ${value.length} chars]`;
}
