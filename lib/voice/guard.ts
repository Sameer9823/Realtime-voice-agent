/**
 * Request guards shared by every public API route.
 *
 * The session route mints an OpenAI ephemeral credential and the tool routes make
 * outbound calls, so both are worth protecting: an open session route is a free proxy
 * to OpenAI, and an open tool route is a free proxy to whatever API the tool calls.
 *
 * Everything here is pure and injectable. The limiter is an interface rather than a
 * concrete map so it can be swapped for a shared store (Redis) when the app runs on
 * more than one instance; see `InMemoryRateLimiter` for the single-instance default.
 */

/** Assistant voices accepted by the session route. */
import type { VoiceErrorKind } from "./types";

export const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse"] as const;

/** Realtime models accepted by the session route. */
export const MODELS = ["gpt-realtime"] as const;

export type Voice = (typeof VOICES)[number];
export type Model = (typeof MODELS)[number];

/** Default limits, overridable through `RATE_LIMIT_*` environment variables. */
export const DEFAULT_RATE_LIMIT = {
  /** Sliding window per client. */
  windowMs: 60_000,
  maxRequests: 20,
};

/** Default global cap, overridable through `GLOBAL_CAP_*` environment variables. */
export const DEFAULT_GLOBAL_CAP = {
  windowMs: 60 * 60_000,
  maxRequests: 600,
};

/** Result of a rate-limit check. `retryAfterMs` is 0 when the request may proceed. */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * A rate limiter. Implementations must be safe to share across requests; anything with
 * mutable state needs its own concurrency story (the in-memory one is a plain map, which
 * is fine for a single Node process because the event loop serialises access).
 */
export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
  /** Drops all recorded state. Used by tests. */
  reset?(): void;
}

/** Fixed-window limiter holding all state in process memory. */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number = DEFAULT_RATE_LIMIT.windowMs,
    private readonly maxRequests: number = DEFAULT_RATE_LIMIT.maxRequests,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async check(key: string): Promise<RateLimitResult> {
    const t = this.now();
    const bucket = this.buckets.get(key);

    if (!bucket || t >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: t + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }

    if (bucket.count >= this.maxRequests) {
      return { allowed: false, retryAfterMs: bucket.resetAt - t };
    }

    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(): void {
    this.buckets.clear();
  }
}

export interface GuardConfig {
  /** Origins allowed to call the API. Empty means same-origin only (no Origin header
   * required), which is correct for a browser-first app. */
  allowedOrigins?: string[];
  /** Limiter used for the per-client check. */
  clientLimiter?: RateLimiter;
  /** Limiter used for the global cap. Set to null to disable the cap. */
  globalLimiter?: RateLimiter | null;
}

function parseList(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Parses a positive integer, returning undefined for anything unset or unparseable.
 * `||` is wrong here: it would turn a deliberate `GLOBAL_CAP_MAX=0` back into the default. */
function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Builds a guard from environment variables, with sane defaults when they are unset. */
export function guardFromEnv(env: Record<string, string | undefined> = process.env): GuardConfig {
  const windowMs = parsePositiveInt(env.RATE_LIMIT_WINDOW_MS) ?? DEFAULT_RATE_LIMIT.windowMs;
  const maxRequests = parsePositiveInt(env.RATE_LIMIT_MAX) ?? DEFAULT_RATE_LIMIT.maxRequests;

  const capWindowMs = parsePositiveInt(env.GLOBAL_CAP_WINDOW_MS) ?? DEFAULT_GLOBAL_CAP.windowMs;
  const capMaxRequests = parsePositiveInt(env.GLOBAL_CAP_MAX) ?? DEFAULT_GLOBAL_CAP.maxRequests;

  return {
    allowedOrigins: parseList(env.ALLOWED_ORIGINS),
    clientLimiter: new InMemoryRateLimiter(windowMs, maxRequests),
    globalLimiter: capMaxRequests > 0 ? new InMemoryRateLimiter(capWindowMs, capMaxRequests) : null,
  };
}

/** Reads the caller's IP, preferring the proxy header Next.js sets behind a host. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

export interface GuardDecision {
  ok: boolean;
  status: number;
  code?: VoiceErrorKind;
  message?: string;
  retryAfterSeconds?: number;
}

function deny(status: number, code: VoiceErrorKind, message: string, retryAfterSeconds?: number): GuardDecision {
  return { ok: false, status, code, message, retryAfterSeconds };
}

/** Checks the `Origin` header. Pass `null` to skip the check entirely. */
export function checkOrigin(origin: string | null, allowedOrigins: string[] | undefined): GuardDecision {
  if (!allowedOrigins) return { ok: true, status: 200 };
  // No Origin header means a same-origin navigation or a non-browser client, which the
  // allowlist cannot speak to; allow it and let the rate limiter carry the load.
  if (!origin) return { ok: true, status: 200 };
  return allowedOrigins.includes(origin)
    ? { ok: true, status: 200 }
    : deny(403, "forbidden", "This origin is not allowed to call this API.");
}

/** Checks a voice against the allowlist. */
export function checkVoice(voice: string): GuardDecision {
  return (VOICES as readonly string[]).includes(voice)
    ? { ok: true, status: 200 }
    : deny(400, "invalid_voice", `Unsupported voice. Choose one of: ${VOICES.join(", ")}.`);
}

/** Checks a model against the allowlist. */
export function checkModel(model: string): GuardDecision {
  return (MODELS as readonly string[]).includes(model)
    ? { ok: true, status: 200 }
    : deny(400, "invalid_model", `Unsupported model. Choose one of: ${MODELS.join(", ")}.`);
}

/**
 * Applies both limiters. `clientKey` identifies the caller (normally an IP, or a user id
 * once auth is enabled) and is also what the global cap is bucketed under when it needs a
 * single key.
 */
export async function checkLimits(
  clientKey: string,
  config: Pick<GuardConfig, "clientLimiter" | "globalLimiter">,
): Promise<GuardDecision> {
  if (!config.clientLimiter) return { ok: true, status: 200 };

  const client = await config.clientLimiter.check(clientKey);
  if (!client.allowed) {
    return deny(429, "rate_limited", "Too many requests. Please wait a moment and try again.", Math.ceil(client.retryAfterMs / 1000));
  }

  if (config.globalLimiter) {
    const global = await config.globalLimiter.check("__global__");
    if (!global.allowed) {
      return deny(429, "rate_limited", "The server is busy right now. Please try again later.", Math.ceil(global.retryAfterMs / 1000));
    }
  }

  return { ok: true, status: 200 };
}
