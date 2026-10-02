import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server route tests.
 *
 * The security-relevant property: `OPENAI_API_KEY` is read only here, and only a short-lived
 * ephemeral credential comes back to the browser.
 */

const ORIGINAL_ENV = { ...process.env };

async function loadRoute() {
  vi.resetModules();
  return (await import("@/app/api/realtime/session/route")).POST;
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test-server-only";
  process.env.OPENAI_BASE_URL = "https://api.openai.test/v1";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/realtime/session", () => {
  it("refuses to mint a credential when no API key is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    const POST = await loadRoute();

    const res = await POST(new Request("http://localhost/api/realtime/session", { method: "POST" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("auth_failed");
    expect(body.message).toMatch(/OPENAI_API_KEY/);
  });

  it("returns an ephemeral client secret and never the API key", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ value: "ek_ephemeral_123", expires_at: 1893456000 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadRoute();
    const res = await POST(
      new Request("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({}) }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.clientSecret).toBe("ek_ephemeral_123");
    expect(body.expiresAt).toBe(1893456000);

    // The long-lived key must not appear anywhere in the response.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("sk-test-server-only");
  });

  it("sends the key only to OpenAI, in the Authorization header", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ value: "ek_x", expires_at: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadRoute();
    await POST(new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.test/v1/realtime/client_secrets");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-server-only");
    // The key must not be smuggled into the request body.
    expect(String(init.body)).not.toContain("sk-test-server-only");
  });

  it("requests a bounded credential lifetime", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ value: "ek_x", expires_at: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadRoute();
    await POST(new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}" }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body.expires_after).toMatchObject({ anchor: "created_at" });
  });

  it("configures transcription and turn detection on the session", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ value: "ek_x", expires_at: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadRoute();
    await POST(new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}" }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      session: {
        instructions: string;
        output_modalities: string[];
        audio: { input: { transcription: { model: string }; turn_detection: { type: string; interrupt_response: boolean } } };
      };
    };
    expect(body.session.instructions).toMatch(/spoken conversation/i);
    // Without this, the user transcript never arrives.
    expect(body.session.audio.input.transcription.model).toBeTruthy();
    expect(body.session.audio.input.turn_detection.type).toBe("semantic_vad");
    expect(body.session.audio.input.turn_detection.interrupt_response).toBe(true);
    // GA accepts exactly one output modality; `["audio", "text"]` is rejected with a 400
    // (`Invalid modalities`) and breaks session creation.
    expect(body.session.output_modalities).toEqual(["audio"]);
  });

  it("tolerates an empty request body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ value: "ek_x", expires_at: null }), { status: 200 })),
    );
    const POST = await loadRoute();
    const res = await POST(new Request("http://localhost/api/realtime/session", { method: "POST" }));
    expect(res.status).toBe(200);
  });

  it("maps an upstream auth failure to a user-safe message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid api key", { status: 401 })));
    const POST = await loadRoute();
    const res = await POST(new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("auth_failed");
    expect(body.message).not.toContain("invalid api key");
  });

  it("maps rate limiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    const POST = await loadRoute();
    const res = await POST(new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}" }));
    expect((await res.json()).error).toBe("rate_limited");
  });

  it("maps an unavailable model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("model not found", { status: 404 })));
    const POST = await loadRoute();
    const res = await POST(new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}" }));
    const body = await res.json();
    expect(body.error).toBe("model_unavailable");
    expect(body.message).not.toContain("model not found");
  });

  it("never returns a stack trace to the client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED at getRealtimeClientSecret (/app/api/realtime/session/route.ts:55)");
      }),
    );
    const POST = await loadRoute();
    const res = await POST(new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}" }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("route.ts");
    expect(text).not.toContain("ECONNREFUSED");
  });
});

describe("POST /api/realtime/session guards", () => {
  function okFetch() {
    return new Response(JSON.stringify({ value: "ek_ephemeral_123", expires_at: 1893456000 }), { status: 200 });
  }

  it("rejects a disallowed origin before spending an OpenAI call", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example";
    const fetchMock = vi.fn(async () => okFetch());
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadRoute();
    const res = await POST(
      new Request("http://localhost/api/realtime/session", {
        method: "POST",
        body: "{}",
        headers: { origin: "https://evil.example" },
      }),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a listed origin", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example";
    vi.stubGlobal("fetch", vi.fn(async () => okFetch()));

    const POST = await loadRoute();
    const res = await POST(
      new Request("http://localhost/api/realtime/session", {
        method: "POST",
        body: "{}",
        headers: { origin: "https://app.example" },
      }),
    );

    expect(res.status).toBe(200);
  });

  it("rate limits repeat calls from one client", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    const fetchMock = vi.fn(async () => okFetch());
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadRoute();
    const headers = { "x-forwarded-for": "5.5.5.5" };

    const first = await POST(new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}", headers }));
    const second = await POST(new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}", headers }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
    // Only the first call may reach OpenAI.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps rate limit buckets separate per client", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    vi.stubGlobal("fetch", vi.fn(async () => okFetch()));

    const POST = await loadRoute();
    const one = await POST(
      new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}", headers: { "x-forwarded-for": "1.1.1.1" } }),
    );
    const two = await POST(
      new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}", headers: { "x-forwarded-for": "2.2.2.2" } }),
    );

    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
  });

  it("applies the global cap across clients", async () => {
    process.env.GLOBAL_CAP_MAX = "1";
    vi.stubGlobal("fetch", vi.fn(async () => okFetch()));

    const POST = await loadRoute();
    const one = await POST(
      new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}", headers: { "x-forwarded-for": "1.1.1.1" } }),
    );
    const two = await POST(
      new Request("http://localhost/api/realtime/session", { method: "POST", body: "{}", headers: { "x-forwarded-for": "2.2.2.2" } }),
    );

    expect(one.status).toBe(200);
    expect(two.status).toBe(429);
  });

  it("refuses a voice outside the allowlist", async () => {
    const fetchMock = vi.fn(async () => okFetch());
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadRoute();
    const res = await POST(
      new Request("http://localhost/api/realtime/session", {
        method: "POST",
        body: JSON.stringify({ voice: "evil-voice" }),
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_voice");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a model outside the allowlist", async () => {
    const POST = await loadRoute();
    const res = await POST(
      new Request("http://localhost/api/realtime/session", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o-realtime-preview" }),
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_model");
  });

  it("accepts a voice from the allowlist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okFetch()));

    const POST = await loadRoute();
    const res = await POST(
      new Request("http://localhost/api/realtime/session", {
        method: "POST",
        body: JSON.stringify({ voice: "onyx" }),
      }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).voice).toBe("onyx");
  });
});