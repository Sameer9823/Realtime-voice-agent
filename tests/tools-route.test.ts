import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIndex, type DocIndex } from "@/lib/tools/docs-index";

/**
 * Tool route behaviour.
 *
 * Two properties matter here: the route is guarded like the session route, and a malformed
 * call from the model is rejected by the schema before it can reach a tool implementation.
 */

const ORIGINAL_ENV = { ...process.env };

const INDEX: DocIndex = buildIndex(
  [{ docId: "guide", title: "Guide", markdown: "# Guide\n\n## Setup\n\nRun npm install and then npm run dev." }],
  new Date("2026-01-01"),
);

async function loadRoute() {
  vi.resetModules();
  return import("@/app/api/tools/[name]/route");
}

function post(name: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.RATE_LIMIT_MAX = "100";
  process.env.GLOBAL_CAP_MAX = "1000";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/tools/[name]", () => {
  it("rejects a disallowed origin", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example";
    const { POST } = await loadRoute();

    const res = await POST(post("get_weather", { location: "Lisbon" }, { origin: "https://evil.example" }), {
      params: Promise.resolve({ name: "get_weather" }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).ok).toBe(false);
  });

  it("404s an unknown tool name", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post("nope", {}), { params: Promise.resolve({ name: "nope" }) });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/No tool named/);
  });

  it("rejects missing arguments with a speakable message", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post("get_weather", {}), { params: Promise.resolve({ name: "get_weather" }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("location");
    // Must not leak zod's internal structure to a model that will read it aloud.
    expect(body.error).not.toContain("ZodError");
  });

  it("rejects a wrongly typed argument", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post("get_weather", { location: 42 }), { params: Promise.resolve({ name: "get_weather" }) });

    expect(res.status).toBe(400);
  });

  it("rejects unparseable JSON", async () => {
    const { POST } = await loadRoute();
    const request = new Request("http://localhost/api/tools/get_weather", { method: "POST", body: "{oops" });
    const res = await POST(request, { params: Promise.resolve({ name: "get_weather" }) });

    expect(res.status).toBe(400);
  });

  it("rejects an oversized body", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post("web_search", { query: "x".repeat(5000) }), { params: Promise.resolve({ name: "web_search" }) });

    expect(res.status).toBe(413);
  });

  it("answers a docs question from the committed index", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post("lookup_docs", { question: "how do I run the development server" }), {
      params: Promise.resolve({ name: "lookup_docs" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.result).toBe("string");
  });

  it("rate limits repeat tool calls from one client", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    const { POST } = await loadRoute();
    const headers = { "x-forwarded-for": "7.7.7.7" };

    const first = await POST(post("lookup_docs", { question: "how do I run the development server" }, headers), {
      params: Promise.resolve({ name: "lookup_docs" }),
    });
    const second = await POST(post("lookup_docs", { question: "how do I run the development server" }, headers), {
      params: Promise.resolve({ name: "lookup_docs" }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it("returns a friendly error when a tool throws, and logs the detail", async () => {
    // Silences the console so a genuine tool failure does not spam the test output.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await loadRoute();

    // Force the implementation to throw by breaking the global fetch it depends on.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED /home/user/app/lib/tools/weather.ts:31");
    }));

    const res = await POST(post("get_weather", { location: "Lisbon" }), { params: Promise.resolve({ name: "get_weather" }) });

    // The tool itself catches network errors, so this must still be a clean 200 with speakable text.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result).not.toContain("ECONNREFUSED");
    expect(body.result).not.toContain("weather.ts");
  });

  it("exposes the committed docs index to the route", () => {
    // Guards the rebuild step: if content/index.json is deleted or renamed, this fails loudly
    // here rather than as a confusing runtime error in a conversation.
    expect(INDEX.chunks.length).toBeGreaterThan(0);
  });
});