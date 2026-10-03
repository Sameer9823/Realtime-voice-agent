import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auth at the route boundary.
 *
 * `REQUIRE_AUTH=true` has to change what the public routes do, and the failure mode that matters is
 * a deployment that asked for a login and quietly served everyone anyway. Both cases are covered
 * here: unconfigured must fail closed, and configured-but-anonymous must be a 401 rather than a
 * pass.
 */

const ORIGINAL_ENV = { ...process.env };

async function loadSessionRoute() {
  vi.resetModules();
  return import("@/app/api/realtime/session/route");
}

async function loadToolsRoute() {
  vi.resetModules();
  return import("@/app/api/tools/[name]/route");
}

function postSession(body: unknown = {}, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/realtime/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.RATE_LIMIT_MAX = "100";
  process.env.GLOBAL_CAP_MAX = "1000";
  process.env.OPENAI_API_KEY = "sk-test";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("auth is off by default", () => {
  it("lets an anonymous caller past the auth check", async () => {
    delete process.env.REQUIRE_AUTH;
    // No key, so the route stops at its own check with a 500 — which is only reachable once the
    // auth check has already let the request through.
    delete process.env.OPENAI_API_KEY;
    const { POST } = await loadSessionRoute();

    const res = await POST(postSession());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("auth_failed");
  });

  it("does not require a provider to be configured", async () => {
    delete process.env.REQUIRE_AUTH;
    delete process.env.OPENAI_API_KEY;
    delete process.env.AUTH_EMAIL;
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_GITHUB_ID;
    const { POST } = await loadSessionRoute();

    const res = await POST(postSession());

    expect(res.status).not.toBe(401);
  });
});

describe("REQUIRE_AUTH=true", () => {
  it("refuses an anonymous session request with 401 when a provider is configured", async () => {
    process.env.REQUIRE_AUTH = "true";
    process.env.AUTH_EMAIL = "ada@example.com";
    process.env.AUTH_PASSWORD = "correct-horse";
    const { POST } = await loadSessionRoute();

    const res = await POST(postSession());

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(body.message).toMatch(/sign in/i);
  });

  it("refuses an anonymous tool request with 401", async () => {
    process.env.REQUIRE_AUTH = "true";
    process.env.AUTH_EMAIL = "ada@example.com";
    process.env.AUTH_PASSWORD = "correct-horse";
    const { POST } = await loadToolsRoute();

    const res = await POST(
      new Request("http://localhost/api/tools/get_weather", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: "Lisbon" }),
      }),
      { params: Promise.resolve({ name: "get_weather" }) },
    );

    expect(res.status).toBe(401);
  });

  it("never calls OpenAI for an anonymous caller", async () => {
    process.env.REQUIRE_AUTH = "true";
    process.env.AUTH_EMAIL = "ada@example.com";
    process.env.AUTH_PASSWORD = "correct-horse";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { POST } = await loadSessionRoute();

    await POST(postSession());

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed with 500 when required but unconfigured, rather than allowing", async () => {
    process.env.REQUIRE_AUTH = "true";
    delete process.env.AUTH_EMAIL;
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_GITHUB_ID;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await loadSessionRoute();

    const res = await POST(postSession());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("forbidden");
  });

  it("does not leak which provider variables are missing", async () => {
    process.env.REQUIRE_AUTH = "true";
    delete process.env.AUTH_EMAIL;
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_GITHUB_ID;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await loadSessionRoute();

    const body = JSON.stringify(await (await POST(postSession())).json());
    expect(body).not.toMatch(/AUTH_|GITHUB|OPENAI_API_KEY/);
  });

  it("checks auth before spending a rate-limit slot", async () => {
    // A flood of anonymous requests must not exhaust the allowance a signed-in user shares.
    process.env.REQUIRE_AUTH = "true";
    process.env.AUTH_EMAIL = "ada@example.com";
    process.env.AUTH_PASSWORD = "correct-horse";
    process.env.RATE_LIMIT_MAX = "2";
    const { POST } = await loadSessionRoute();

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await POST(postSession())).status);

    expect(statuses).toEqual([401, 401, 401, 401]);
  });

  it("still refuses a disallowed origin ahead of the auth check", async () => {
    process.env.REQUIRE_AUTH = "true";
    process.env.ALLOWED_ORIGINS = "https://app.example";
    process.env.AUTH_EMAIL = "ada@example.com";
    process.env.AUTH_PASSWORD = "correct-horse";
    const { POST } = await loadSessionRoute();

    const res = await POST(postSession({}, { origin: "https://evil.example" }));

    expect(res.status).toBe(403);
  });
});
