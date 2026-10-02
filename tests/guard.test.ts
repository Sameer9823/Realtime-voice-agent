import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_LIMIT,
  InMemoryRateLimiter,
  MODELS,
  VOICES,
  checkLimits,
  checkModel,
  checkOrigin,
  checkVoice,
  clientKey,
  guardFromEnv,
} from "@/lib/voice/guard";

/** Deterministic clock so window boundaries can be tested exactly. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe("checkOrigin", () => {
  it("allows any origin when no allowlist is configured", () => {
    expect(checkOrigin("https://evil.example", undefined).ok).toBe(true);
  });

  it("allows a listed origin", () => {
    expect(checkOrigin("https://app.example", ["https://app.example"]).ok).toBe(true);
  });

  it("rejects an origin that is not listed", () => {
    const decision = checkOrigin("https://evil.example", ["https://app.example"]);
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(403);
    expect(decision.code).toBe("forbidden");
  });

  it("is not fooled by a suffix match", () => {
    expect(checkOrigin("https://app.example.evil.com", ["https://app.example"]).ok).toBe(false);
  });

  it("treats a missing Origin header as allowed", () => {
    // A same-origin fetch or a non-browser client sends no Origin; rejecting it would break
    // curl-based health checks and the app's own relative requests.
    expect(checkOrigin(null, ["https://app.example"]).ok).toBe(true);
  });
});

describe("checkVoice / checkModel", () => {
  it("accepts every allowlisted voice", () => {
    for (const voice of VOICES) {
      expect(checkVoice(voice).ok, voice).toBe(true);
    }
  });

  it("accepts every allowlisted model", () => {
    for (const model of MODELS) {
      expect(checkModel(model).ok, model).toBe(true);
    }
  });

  it("rejects an unknown voice and lists the valid ones", () => {
    const decision = checkVoice("not-a-voice");
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(400);
    expect(decision.message).toContain("marin");
  });

  it("rejects an unknown model", () => {
    expect(checkModel("gpt-4o-realtime-preview").ok).toBe(false);
  });

  it("rejects an empty voice", () => {
    expect(checkVoice("").ok).toBe(false);
  });
});

describe("InMemoryRateLimiter", () => {
  it("allows up to the limit then rejects", async () => {
    const c = clock();
    const limiter = new InMemoryRateLimiter(1000, 2, c.now);

    expect((await limiter.check("a")).allowed).toBe(true);
    expect((await limiter.check("a")).allowed).toBe(true);
    const blocked = await limiter.check("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
  });

  it("starts a fresh window once the old one expires", async () => {
    const c = clock();
    const limiter = new InMemoryRateLimiter(1000, 1, c.now);

    expect((await limiter.check("a")).allowed).toBe(true);
    expect((await limiter.check("a")).allowed).toBe(false);

    c.advance(1000);
    expect((await limiter.check("a")).allowed).toBe(true);
  });

  it("buckets keys independently", async () => {
    const c = clock();
    const limiter = new InMemoryRateLimiter(1000, 1, c.now);

    expect((await limiter.check("a")).allowed).toBe(true);
    expect((await limiter.check("b")).allowed).toBe(true);
    expect((await limiter.check("a")).allowed).toBe(false);
  });

  it("reports a shrinking retryAfter as the window drains", async () => {
    const c = clock();
    const limiter = new InMemoryRateLimiter(1000, 1, c.now);

    await limiter.check("a");
    await limiter.check("a");
    c.advance(400);
    expect((await limiter.check("a")).retryAfterMs).toBe(600);
  });

  it("clears all state on reset", async () => {
    const limiter = new InMemoryRateLimiter(1000, 1, clock().now);
    await limiter.check("a");
    expect((await limiter.check("a")).allowed).toBe(false);
    limiter.reset();
    expect((await limiter.check("a")).allowed).toBe(true);
  });
});

describe("checkLimits", () => {
  it("rejects once the client is over its limit and reports a retry hint", async () => {
    const c = clock();
    // max: 1 means the first request is fine and the second is the one that trips.
    const config = { clientLimiter: new InMemoryRateLimiter(60_000, 1, c.now), globalLimiter: null };

    expect((await checkLimits("1.2.3.4", config)).ok).toBe(true);

    const decision = await checkLimits("1.2.3.4", config);
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(429);
    expect(decision.code).toBe("rate_limited");
    expect(decision.retryAfterSeconds).toBe(60);
  });

  it("lets other clients through when one is limited", async () => {
    const limiter = new InMemoryRateLimiter(60_000, 1, clock().now);
    const config = { clientLimiter: limiter, globalLimiter: null };

    expect((await checkLimits("a", config)).ok).toBe(true);
    expect((await checkLimits("a", config)).ok).toBe(false);
    expect((await checkLimits("b", config)).ok).toBe(true);
  });

  it("enforces the global cap across otherwise-fine clients", async () => {
    const c = clock();
    // The cap is one shared bucket, so both calls must use the same limiter instance.
    const config = {
      clientLimiter: new InMemoryRateLimiter(60_000, 100, c.now),
      globalLimiter: new InMemoryRateLimiter(60_000, 1, c.now),
    };

    expect((await checkLimits("a", config)).ok).toBe(true);

    // A different client, well under its own limit, is refused because the cap is spent.
    const second = await checkLimits("b", config);
    expect(second.ok).toBe(false);
    expect(second.code).toBe("rate_limited");
  });

  it("never counts the client request against the global cap twice", async () => {
    // The global cap is a single bucket, so a request must consume one unit, not two.
    const calls: string[] = [];
    const limiter = new InMemoryRateLimiter(60_000, 100, clock().now);
    const decision = await checkLimits("a", {
      clientLimiter: limiter,
      globalLimiter: {
        check: async (key) => {
          calls.push(key);
          return { allowed: true, retryAfterMs: 0 };
        },
      },
    });
    expect(decision.ok).toBe(true);
    expect(calls).toEqual(["__global__"]);
  });
});

describe("clientKey", () => {
  it("prefers the first forwarded address", () => {
    const request = new Request("http://localhost", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } });
    expect(clientKey(request)).toBe("1.1.1.1");
  });

  it("falls back to x-real-ip", () => {
    const request = new Request("http://localhost", { headers: { "x-real-ip": "9.9.9.9" } });
    expect(clientKey(request)).toBe("9.9.9.9");
  });

  it("returns a stable bucket when no headers are present", () => {
    expect(clientKey(new Request("http://localhost"))).toBe("unknown");
  });
});

describe("guardFromEnv", () => {
  let config: ReturnType<typeof guardFromEnv>;
  beforeEach(() => {
    config = guardFromEnv({});
  });

  it("parses a comma-separated origin list", () => {
    config = guardFromEnv({ ALLOWED_ORIGINS: "https://a.example, https://b.example" });
    expect(checkOrigin("https://b.example", config.allowedOrigins).ok).toBe(true);
    expect(checkOrigin("https://c.example", config.allowedOrigins).ok).toBe(false);
  });

  it("ignores blank entries in the origin list", () => {
    config = guardFromEnv({ ALLOWED_ORIGINS: "https://a.example, ,  " });
    expect(config.allowedOrigins).toEqual(["https://a.example"]);
  });

  it("defaults the per-client limit", async () => {
    expect(DEFAULT_RATE_LIMIT.maxRequests).toBeGreaterThan(0);
    const limiter = config.clientLimiter!;
    for (let i = 0; i < DEFAULT_RATE_LIMIT.maxRequests; i += 1) {
      expect((await limiter.check("k")).allowed).toBe(true);
    }
    expect((await limiter.check("k")).allowed).toBe(false);
  });

  it("enables the global cap by default", () => {
    expect(config.globalLimiter).not.toBeNull();
  });

  it("disables the global cap when the max is zero", () => {
    expect(guardFromEnv({ GLOBAL_CAP_MAX: "0" }).globalLimiter).toBeNull();
  });
});