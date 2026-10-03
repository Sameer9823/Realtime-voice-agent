import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { VOICE_TOOLS, callTool, clearPendingConfirmations, createConfirmedTool, hasPendingConfirmation } from "@/lib/voice/tools";

/**
 * Browser-side tool stubs.
 *
 * The stub is the only place the browser learns what a tool is called and what arguments it
 * takes. It must forward to the server route and must never carry a credential itself.
 */

beforeEach(() => {
  clearPendingConfirmations();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function okFetch(result = "It is sunny in Lisbon.") {
  // Typed with the request parameters so `mock.calls` entries can be inspected safely.
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
}

describe("callTool", () => {
  it("posts JSON to the named tool route", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await callTool({ name: "get_weather", args: { location: "Lisbon" } });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/tools/get_weather");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ location: "Lisbon" });
  });

  it("url-encodes the tool name", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    await callTool({ name: "a b", args: {} });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/tools/a%20b");
  });

  it("unwraps a successful result", async () => {
    vi.stubGlobal("fetch", okFetch());
    expect(await callTool({ name: "get_weather", args: {} })).toEqual({ result: "It is sunny in Lisbon." });
  });

  it("surfaces a server error message rather than a status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "I couldn't find a place called X." }), { status: 404 })),
    );

    const out = await callTool({ name: "get_weather", args: {} });
    expect(out.error).toBe("I couldn't find a place called X.");
    expect(JSON.stringify(out)).not.toContain("404");
  });

  it("copes with a non-JSON error body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    const out = await callTool({ name: "web_search", args: {} });
    expect(out.error).toMatch(/web search tool could not run/);
  });

  it("copes with an unreachable server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Failed to fetch");
      }),
    );
    expect(await callTool({ name: "web_search", args: {} })).toEqual({ error: "I couldn't reach the tools server." });
  });
});

describe("VOICE_TOOLS", () => {
  it("exposes the three read-only tools", () => {
    expect(VOICE_TOOLS.map((tool) => tool.name).sort()).toEqual(["get_weather", "lookup_docs", "web_search"]);
  });

  it("never embeds a secret in any definition", () => {
    // The browser bundle ships these. A stray key here would leak to every visitor.
    const serialised = JSON.stringify(VOICE_TOOLS, (_key, value) =>
      typeof value === "function" ? "[function]" : value,
    );
    expect(serialised).not.toMatch(/sk-[a-zA-Z0-9]/);
    expect(serialised).not.toMatch(/tvly-/);
    expect(serialised).not.toContain("API_KEY");
  });
});

describe("confirmation gate", () => {
  it("runs a read-only tool immediately", async () => {
    const fetchMock = okFetch("done");
    vi.stubGlobal("fetch", fetchMock);

    const tool = createConfirmedTool({
      name: "read_only_thing",
      description: "reads",
      parameters: z.object({ q: z.string() }),
      sideEffects: false,
    });

    const result = (await tool.execute({ q: "x" })) as Record<string, unknown>;
    expect(result.result).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call a side-effecting tool on the first attempt", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const tool = createConfirmedTool({
      name: "send_email",
      description: "sends",
      parameters: z.object({ to: z.string(), confirmed: z.boolean().optional() }),
      sideEffects: true,
    });

    const result = (await tool.execute({ to: "a@b.test" })) as Record<string, unknown>;
    expect(result.needsConfirmation).toBe(true);
    expect(result.message).toMatch(/permission/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a confirmed call when the user was never asked", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const tool = createConfirmedTool({
      name: "send_email",
      description: "sends",
      parameters: z.object({ to: z.string(), confirmed: z.boolean().optional() }),
      sideEffects: true,
    });

    // The model skipping straight to confirmed: true must not be enough.
    const result = (await tool.execute({ to: "a@b.test", confirmed: true })) as Record<string, unknown>;
    expect(result.needsConfirmation).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs the tool once the user has agreed", async () => {
    const fetchMock = okFetch("sent");
    vi.stubGlobal("fetch", fetchMock);

    const tool = createConfirmedTool({
      name: "send_email",
      description: "sends",
      parameters: z.object({ to: z.string(), confirmed: z.boolean().optional() }),
      sideEffects: true,
    });

    await tool.execute({ to: "a@b.test" });
    const result = (await tool.execute({ to: "a@b.test", confirmed: true })) as Record<string, unknown>;

    expect(result.result).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // `confirmed` is a prompt-side concern and must not reach the tool implementation.
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ to: "a@b.test" });
  });

  it("expires the confirmation so a stale yes cannot authorise a later call", async () => {
    // Fake timers because the TTL is measured with Date.now() inside the gate.
    vi.useFakeTimers();
    try {
      const fetchMock = okFetch();
      vi.stubGlobal("fetch", fetchMock);

      const tool = createConfirmedTool({
        name: "send_email",
        description: "sends",
        parameters: z.object({ confirmed: z.boolean().optional() }),
        sideEffects: true,
      });

      await tool.execute({});
      expect(hasPendingConfirmation("send_email")).toBe(true);

      // The TTL is 60s. Just inside it the permission still stands.
      vi.advanceTimersByTime(59_000);
      expect(hasPendingConfirmation("send_email")).toBe(true);

      // Past it, the permission has lapsed.
      vi.advanceTimersByTime(2_000);
      expect(hasPendingConfirmation("send_email")).toBe(false);

      const result = (await tool.execute({ confirmed: true })) as Record<string, unknown>;
      expect(result.needsConfirmation).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a confirmation for one tool from unlocking another", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const make = (name: string) =>
      createConfirmedTool({ name, description: "d", parameters: z.object({ confirmed: z.boolean().optional() }), sideEffects: true });

    await make("send_email").execute({});
    const result = (await make("delete_everything").execute({ confirmed: true })) as Record<string, unknown>;

    expect(result.needsConfirmation).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("consumes the confirmation so one yes cannot authorise two calls", async () => {
    const fetchMock = okFetch("ok");
    vi.stubGlobal("fetch", fetchMock);

    const tool = createConfirmedTool({
      name: "send_email",
      description: "sends",
      parameters: z.object({ confirmed: z.boolean().optional() }),
      sideEffects: true,
    });

    await tool.execute({});
    await tool.execute({ confirmed: true });
    const second = (await tool.execute({ confirmed: true })) as Record<string, unknown>;

    expect(second.needsConfirmation).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});