import { describe, expect, it, vi } from "vitest";
import { createRealtimeClientSecret } from "samai-sdk/voice";

/**
 * Ephemeral credential minting (the SDK helper behind the server route).
 *
 * This is the part of the realtime stack that cannot be verified against a live OpenAI key from a
 * test environment, so the request shape, auth placement, response parsing, and failure handling are
 * pinned here instead.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("createRealtimeClientSecret", () => {
  it("posts to the realtime client-secrets endpoint with bearer auth", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ value: "ek_abc", expires_at: 123 }));

    const result = await createRealtimeClientSecret({
      apiKey: "sk-server-only",
      model: "gpt-realtime",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-server-only");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(result).toEqual({ value: "ek_abc", expiresAt: 123 });
  });

  it("sends a GA realtime session body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ value: "ek_abc" }));

    await createRealtimeClientSecret({
      apiKey: "sk-test",
      model: "gpt-realtime",
      ttlSeconds: 600,
      session: {
        instructions: "be brief",
        // GA accepts exactly one output modality. `["audio", "text"]` is rejected by the API with
        // `Invalid modalities`, so this is pinned to catch a regression at build time.
        output_modalities: ["audio"],
        audio: { input: { turn_detection: { type: "semantic_vad" } } },
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "realtime",
        model: "gpt-realtime",
        instructions: "be brief",
        output_modalities: ["audio"],
        audio: { input: { turn_detection: { type: "semantic_vad" } } },
      },
    });
  });

  it("rejects a session requesting both audio and text output modalities", async () => {
    // Documents why the app pins a single modality: this exact shape is a live 400.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(
        {
          error: {
            message:
              "Invalid modalities: ['audio', 'text']. Supported combinations are: ['text'] and ['audio'].",
            type: "invalid_request_error",
            param: "session.output_modalities",
            code: "invalid_value",
          },
        },
        400,
      ),
    );

    await expect(
      createRealtimeClientSecret({
        apiKey: "sk-test",
        session: { output_modalities: ["audio", "text"] },
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Invalid modalities/);
  });

  it("omits expires_after when no lifetime is requested", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ value: "ek_abc" }));
    await createRealtimeClientSecret({ apiKey: "sk-test", fetchImpl: fetchMock as unknown as typeof fetch });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body.expires_after).toBeUndefined();
  });

  it("honours a base URL override for a proxy or gateway", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ value: "ek_abc" }));
    await createRealtimeClientSecret({
      apiKey: "sk-test",
      baseUrl: "https://proxy.internal/v1",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://proxy.internal/v1/realtime/client_secrets");
  });

  it("adds the safety-identifier header only when supplied", async () => {
    const withId = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ value: "ek" }));
    await createRealtimeClientSecret({ apiKey: "sk", safetyIdentifier: "session-42", fetchImpl: withId as unknown as typeof fetch });
    expect((withId.mock.calls[0]![1]!.headers as Record<string, string>)["OpenAI-Safety-Identifier"]).toBe("session-42");

    const withoutId = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ value: "ek" }));
    await createRealtimeClientSecret({ apiKey: "sk", fetchImpl: withoutId as unknown as typeof fetch });
    expect((withoutId.mock.calls[0]![1]!.headers as Record<string, string>)["OpenAI-Safety-Identifier"]).toBeUndefined();
  });

  it("reports the HTTP status when OpenAI rejects the request", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("no access", { status: 403 }));
    await expect(
      createRealtimeClientSecret({ apiKey: "sk", fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/403/);
  });

  it("truncates a huge upstream error body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("x".repeat(5000), { status: 500 }));
    await expect(
      createRealtimeClientSecret({ apiKey: "sk", fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/^Failed to create realtime client secret \(500: x{300}\)\.$/);
  });

  it("rejects a response with no credential rather than returning undefined", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ expires_at: 1 }));
    await expect(
      createRealtimeClientSecret({ apiKey: "sk", fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/did not include a value/);
  });

  it("tolerates a missing expiry", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ value: "ek" }));
    await expect(
      createRealtimeClientSecret({ apiKey: "sk", fetchImpl: fetchMock as unknown as typeof fetch }),
    ).resolves.toEqual({ value: "ek", expiresAt: null });
  });
});