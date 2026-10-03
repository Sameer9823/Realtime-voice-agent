import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { SESSION_COOKIE } from "@/lib/auth-env";

/**
 * Middleware routing.
 *
 * The middleware is the user-experience half of the auth gate: it sends signed-out visitors to the
 * login page instead of leaving them on a screen that will fail. It is deliberately not the
 * security boundary — `checkAuth()` in the route handlers does the real verification — so these
 * tests are about where people are sent, not about what they are allowed to do.
 */

const ORIGINAL_ENV = { ...process.env };

function request(path: string, cookie?: string) {
  return new NextRequest(`https://voice.example${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

beforeEach(() => {
  process.env.REQUIRE_AUTH = "true";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("middleware with auth required", () => {
  it("sends a signed-out page request to the login page", () => {
    const res = middleware(request("/"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("from")).toBe("/");
  });

  it("answers an API request with JSON, not a redirect to an HTML page", async () => {
    const res = middleware(request("/api/realtime/session"));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("lets a request carrying a session cookie through", () => {
    const res = middleware(request("/", `${SESSION_COOKIE}=abc`));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("ignores a cookie with the wrong name", () => {
    const res = middleware(request("/", "some-other-cookie=abc"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("leaves the login page and the auth endpoints reachable", () => {
    for (const path of ["/login", "/api/auth/signin", "/api/health"]) {
      const res = middleware(request(path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("carries the query string into the return path", () => {
    const res = middleware(request("/?voice=marin"));
    expect(new URL(res.headers.get("location")!).searchParams.get("from")).toBe("/?voice=marin");
  });

  it("does not become an open redirect for an off-site return path", () => {
    // Only the path is echoed back, so a crafted `from` cannot send anyone off this origin.
    const res = middleware(request("/?next=https://evil.example"));
    const from = new URL(res.headers.get("location")!).searchParams.get("from")!;
    expect(from.startsWith("/")).toBe(true);
  });
});

describe("middleware with auth off", () => {
  it("lets everything through", () => {
    process.env.REQUIRE_AUTH = "false";
    for (const path of ["/", "/api/realtime/session", "/api/usage"]) {
      const res = middleware(request(path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });
});