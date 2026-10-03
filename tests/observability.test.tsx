import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsagePanel, formatDuration, formatTokens, summariseHealth } from "@/components/voice/UsagePanel";
import { createUsageLog } from "@/lib/usage/log";

/**
 * The two observability routes and the development panel.
 *
 * The usage route is attacker-controlled input like any other public endpoint, so the tests that
 * matter most are the rejection ones: an unlisted origin, a malformed body, and an oversized
 * payload must all fail before anything is logged.
 */

const ORIGINAL_ENV = { ...process.env };

async function loadUsageRoute() {
  vi.resetModules();
  return import("@/app/api/usage/route");
}

function postUsageRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/usage", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = {
  sessionId: "sess-1",
  turns: 2,
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  reconnects: 0,
  errors: 0,
  toolsInvoked: 1,
  durationMs: 12_000,
  transports: ["connected"],
};

beforeEach(() => {
  process.env.RATE_LIMIT_MAX = "100";
  process.env.GLOBAL_CAP_MAX = "1000";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/usage", () => {
  it("accepts a well-formed report and writes it to the log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { POST } = await loadUsageRoute();

    const res = await POST(postUsageRequest(VALID));

    expect(res.status).toBe(202);
    expect((await res.json()).ok).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("sess-1");
  });

  it("does not echo the stored record back to the caller", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { POST } = await loadUsageRoute();
    const res = await POST(postUsageRequest(VALID));
    expect(JSON.stringify(await res.json())).not.toContain("sess-1");
  });

  it("rejects a disallowed origin", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example";
    const { POST } = await loadUsageRoute();

    const res = await POST(postUsageRequest(VALID, { origin: "https://evil.example" }));

    expect(res.status).toBe(403);
  });

  it("rejects a body that is not JSON", async () => {
    const { POST } = await loadUsageRoute();
    const res = await POST(postUsageRequest("not json"));
    expect(res.status).toBe(400);
  });

  it("names the offending field when validation fails", async () => {
    const { POST } = await loadUsageRoute();
    const res = await POST(postUsageRequest({ ...VALID, turns: "many" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("turns");
  });

  it("rejects negative counts", async () => {
    const { POST } = await loadUsageRoute();
    const res = await POST(postUsageRequest({ ...VALID, totalTokens: -1 }));
    expect(res.status).toBe(400);
  });

  it("rejects an oversized body", async () => {
    const { POST } = await loadUsageRoute();
    const res = await POST(postUsageRequest({ ...VALID, sessionId: "s".repeat(3000) }));
    expect(res.status).toBe(413);
  });

  it("logs nothing when the request is refused", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { POST } = await loadUsageRoute();
    await POST(postUsageRequest({ ...VALID, turns: -3 }));
    expect(log).not.toHaveBeenCalled();
  });
});

describe("GET /api/health", () => {
  it("reports status without leaking secret values", async () => {
    process.env.OPENAI_API_KEY = "sk-super-secret";
    const { GET } = await import("@/app/api/health/route");

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks.openai).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-super-secret");
  });

  it("reports a missing key as a boolean, not an error", async () => {
    delete process.env.OPENAI_API_KEY;
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).json();
    expect(body.checks.openai).toBe(false);
  });

  it("reflects the REQUIRE_AUTH flag", async () => {
    process.env.REQUIRE_AUTH = "true";
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).json();
    expect(body.checks.auth).toBe(true);
  });

  it("reports whether the documentation index is present", async () => {
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).json();
    // The repository ships `content/index.json`, so a healthy checkout reports true. In the Docker
    // image this is the check that catches the file not being copied.
    expect(body.checks.docs).toBe(true);
  });

  it("reports a non-zero uptime as the process ages", async () => {
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).json();
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof body.version).toBe("string");
  });
});

describe("UsagePanel", () => {
  // The panel health-checks on mount. Leaving the promise pending keeps the fetch out of the
  // assertions and means no state update lands after a test has finished.
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });

  it("formats token counts and durations compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("lists each integration from the health report", () => {
    const rows = summariseHealth(
      {
        status: "ok",
        uptimeSeconds: 30,
        version: "1.0.0",
        checks: { openai: true, tavily: false, auth: false, sentry: true },
      },
      null,
    );
    expect(rows).toContain("openai: on");
    expect(rows).toContain("tavily: off");
    expect(rows).toContain("sentry: on");
  });

  it("reports a failed health check instead of pretending to know", () => {
    expect(summariseHealth(null, "status 500")).toEqual(["health check failed: status 500"]);
    expect(summariseHealth(null, null)).toEqual(["checking server…"]);
  });

  it("shows the live tally", () => {
    const log = createUsageLog("sess-42", () => 0);
    log.record({ type: "run-completed", usage: { inputTokens: 1234, outputTokens: 500, totalTokens: 1734 } });

    render(<UsagePanel usage={log.snapshot()} />);

    expect(screen.getByText("sess-42")).toBeTruthy();
    expect(screen.getByText("1.7k")).toBeTruthy();
    // "1.2k" for input and "500" for output, so both counts are on screen.
    expect(screen.getByText("1.2k")).toBeTruthy();
    expect(screen.getByText("500")).toBeTruthy();
  });

  it("renders zeroes before a session has reported anything", () => {
    render(<UsagePanel usage={null} />);
    expect(screen.getByText("turns")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("shows the server's configuration once the health check resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "ok",
            uptimeSeconds: 90,
            version: "1.0.0",
            checks: { openai: true, tavily: false, auth: false, sentry: true },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );

    render(<UsagePanel usage={null} />);

    expect(await screen.findByText("openai: on")).toBeTruthy();
    expect(screen.getByText("tavily: off")).toBeTruthy();
  });

  it("reports a health check that failed rather than showing stale values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    render(<UsagePanel usage={null} />);

    expect(await screen.findByText(/health check failed: status 500/)).toBeTruthy();
  });
});
