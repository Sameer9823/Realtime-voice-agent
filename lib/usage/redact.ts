/**
 * Key names whose values are secret.
 *
 * Matched against whole segments of a key name, never as substrings. A substring match on `token`
 * redacts `totalTokens`, `inputTokens`, and `outputTokens` — which are counts, not secrets — and
 * silently destroys the entire usage record while appearing to work. Segment matching also has to
 * survive camelCase and snake_case: `\btoken\b` would catch neither `totalTokens` (no boundary
 * inside a word) nor `auth_token` (underscore is a word character), so both were wrong.
 *
 * Note the absence of a plural `tokens`. This application's own payload is
 * `{inputTokens, outputTokens, totalTokens}` and those are counts; adding `tokens` back to this set
 * re-creates the exact bug above. A field literally named `tokens` holding a secret would not be
 * caught, which is the smaller problem — a leaked count is not a credential.
 */
const SECRET_SEGMENTS = new Set([
  "key",
  "apikey",
  "secret",
  "passwd",
  "password",
  "pwd",
  "passphrase",
  "token",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "privatekey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "bearer",
  "signature",
]);

const MAX_STRING_LENGTH = 500;
const KEEP_PREFIX = 200;

/**
 * Splits a key name into lowercase segments on separators and camelCase boundaries, so
 * `OPENAI_API_KEY` yields `openai`, `api`, `key` and `inputTokens` yields `input`, `tokens`.
 */
export function keySegments(key: string): string[] {
  return key
    // Split camelCase and PascalCase runs before the numeric word boundary too, so `APIKey` and
    // `api2Key` both separate.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

/** True when any segment of the key name is a known secret name. */
export function isSecretKey(key: string): boolean {
  return keySegments(key).some((segment) => SECRET_SEGMENTS.has(segment));
}

export function redactValue(value: unknown, keyName?: string): unknown {
  if (keyName && isSecretKey(keyName)) return "[redacted]";
  if (typeof value === "string") return truncate(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") return redactObject(value as Record<string, unknown>);
  return value;
}

export function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = isSecretKey(key) ? "[redacted]" : redactValue(value, key);
  }
  return output;
}

export function truncate(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, KEEP_PREFIX)}…[truncated ${value.length} chars]`;
}
