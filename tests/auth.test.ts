import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constantTimeEquals, decideAuth, authRequired } from "@/lib/auth";
import { UpstashRateLimiter, upstashLimiterFromEnv } from "@/lib/voice/redis-limiter";
import { InMemoryRateLimiter } from "@/lib/voice/guard";

/**
 * Optional auth and the optional shared rate-limit store.
 *
 * The decision table is tested directly rather than through a signed-in session: producing a real
 * NextAuth session needs a Next request context, and the part worth proving is that an absent
 * identity is refused and a misconfigured deployment fails closed. The route-level 401 is covered
 * in `auth-route.test.ts`.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("authRequired", () => {
  it("is off unless the variable is exactly true", () => {
    expect(authRequired({})).toBe(false);
    expect(authRequired({ REQUIRE_AUTH: "false" })).toBe(false);
    expect(authRequired({ REQUIRE_AUTH: "1" })).toBe(false);
    expect(authRequired({ REQUIRE_AUTH: "TRUE" })).toBe(false);
    expect(authRequired({ REQUIRE_AUTH: "true" })).toBe(true);
  });
});

describe("decideAuth", () => {
  it("admits a signed-in caller", () => {
    expect(decideAuth({ userId: "ada@example.com" }, true)).toEqual({ ok: true, status: 200 });
  });

  it("refuses an anonymous caller with 401 when a provider exists", () => {
    const decision = decideAuth(null, true);
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(401);
    expect(decision.code).toBe("unauthorized");
  });

  it("fails closed when auth is required but unconfigured", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const decision = decideAuth(null, false);
    expect(decision.status).toBe(500);
    expect(decision.ok).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  it("never leaks configuration detail to an unconfigured client", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(decideAuth(null, false).message).not.toMatch(/AUTH_|GITHUB/i);
  });
});

describe("constantTimeEquals", () => {
  it("accepts an exact match", () => {
    expect(constantTimeEquals("secret", "secret")).toBe(true);
  });

  it("rejects a mismatch", () => {
    expect(constantTimeEquals("secret", "secrets")).toBe(false);
    expect(constantTimeEquals("secret", "sekret")).toBe(false);
  });

  it("rejects an unset expected value rather than matching empty", () => {
    expect(constantTimeEquals("", undefined)).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });
});

/**
 * A stand-in for the Upstash client. Only the chainable surface the limiter uses is implemented,
 * so a change to the limiter that reaches for anything else fails here rather than in production.
 */
function fakeRedis(counters = new Map<string, number>()) {
  const calls: { op: string; key: string; arg?: number }[] = [];
  // Mirrors Redis: a key exists until something sets a TTL, and `pttl` reports -1 for a key with no
  // expiry. Reporting a TTL for a key that has none would hide the limiter's own fallback path.
  const ttls = new Map<string, number>();

  const pipeline = () => {
    const queued: { op: string; key: string; arg?: number }[] = [];
    const api = {
      incr(key: string) {
        queued.push({ op: "incr", key });
        return api;
      },
      pttl(key: string) {
        queued.push({ op: "pttl", key });
        return api;
      },
      expire(key: string, arg: number) {
        queued.push({ op: "expire", key, arg });
        return api;
      },
      async exec() {
        const results = queued.map((call) => {
          calls.push(call);
          if (call.op === "incr") {
            const next = (counters.get(call.key) ?? 0) + 1;
            counters.set(call.key, next);
            return { result: next };
          }
          if (call.op === "pttl") return { result: ttls.get(call.key) ?? -1 };
          ttls.set(call.key, (call.arg ?? 0) * 1000);
          return { result: 1 };
        });
        return results as [{ result: number }, { result: number }];
      },
    };
    return api;
  };

  return { pipeline, calls };
}

describe("UpstashRateLimiter", () => {
  it("allows requests up to the limit and refuses the next one", async () => {
    const redis = fakeRedis();
    const limiter = new UpstashRateLimiter(redis, 60_000, 2);

    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
    const denied = await limiter.check("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("sets an expiry only on the first request in a window", async () => {
    const redis = fakeRedis();
    const limiter = new UpstashRateLimiter(redis, 60_000, 5);

    await limiter.check("k");
    await limiter.check("k");
    await limiter.check("k");

    const expiries = redis.calls.filter((call) => call.op === "expire");
    expect(expiries).toHaveLength(1);
    expect(expiries[0].arg).toBe(60);
  });

  it("keeps keys in separate windows", async () => {
    const redis = fakeRedis();
    const limiter = new UpstashRateLimiter(redis, 60_000, 1);
    expect((await limiter.check("a")).allowed).toBe(true);
    expect((await limiter.check("b")).allowed).toBe(true);
  });

  it("namespaces keys with a prefix", async () => {
    const redis = fakeRedis();
    await new UpstashRateLimiter(redis, 60_000, 5, "app:rl:").check("k");
    expect(redis.calls[0].key).toBe("app:rl:k");
  });

  it("falls back to the window length when the key has no expiry", async () => {
    const redis = fakeRedis();
    const limiter = new UpstashRateLimiter(redis, 30_000, 0);
    const denied = await limiter.check("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(30_000);
  });

  it("satisfies the guard's RateLimiter interface", () => {
    const limiter = new UpstashRateLimiter(fakeRedis(), 1000, 1);
    expect(limiter).toBeInstanceOf(Object);
    expect(typeof limiter.check).toBe("function");
  });
});

describe("upstashLimiterFromEnv", () => {
  it("returns null when Upstash is not configured", async () => {
    const loader = vi.fn();
    await expect(upstashLimiterFromEnv({}, loader)).resolves.toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it("builds a limiter when both variables are present", async () => {
    const loader = vi.fn(async () => ({ Redis: class {} }));
    const limiter = await upstashLimiterFromEnv(
      { UPSTASH_REDIS_REST_URL: "https://example.upstash.io", UPSTASH_REDIS_REST_TOKEN: "tok" },
      loader as never,
    );
    expect(limiter).toBeInstanceOf(UpstashRateLimiter);
  });

  it("returns null when the package is not installed, so the app still runs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limiter = await upstashLimiterFromEnv(
      { UPSTASH_REDIS_REST_URL: "https://example.upstash.io", UPSTASH_REDIS_REST_TOKEN: "tok" },
      (async () => {
        throw new Error("Cannot find module '@upstash/redis'");
      }) as never,
    );
    expect(limiter).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("only needs a url and a token together", async () => {
    await expect(upstashLimiterFromEnv({ UPSTASH_REDIS_REST_URL: "https://example.upstash.io" })).resolves.toBeNull();
  });
});

describe("in-memory limiter still works alongside", () => {
  // The shared store is opt-in; the default single-instance path must be untouched by it.
  it("counts with the in-memory limiter when Redis is absent", async () => {
    const limiter = new InMemoryRateLimiter(1000, 1, () => 0);
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(false);
  });
});

beforeEach(() => {
  process.env.RATE_LIMIT_MAX = "100";
  process.env.GLOBAL_CAP_MAX = "1000";
});
