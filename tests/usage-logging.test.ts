import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsageLog } from "@/lib/usage/log";
import { postUsage, toUsagePayload } from "@/lib/usage/report";
import { redactObject, truncate } from "@/lib/usage/redact";
import { captureException, initSentry, resetSentryForTests, sentryEnabled } from "@/lib/sentry";
import type { VoiceAgentEvent } from "samai-sdk/voice";

/**
 * Observability: usage accounting, redaction, reporting, and the optional Sentry bridge.
 *
 * The counters are fed synthetic events rather than a live session — `run-completed` is the only
 * event carrying token counts, and a test that depends on OpenAI would test nothing but the
 * network.
 */

const ORIGINAL_ENV = { ...process.env };

function usage(inputTokens: number, outputTokens: number): VoiceAgentEvent {
  return {
    type: "run-completed",
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  };
}

/** A clock the tests advance by hand, so durations are exact rather than wall-clock dependent. */
function fakeClock(startMs = 1_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetSentryForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createUsageLog", () => {
  it("sums tokens and turns across run-completed events", () => {
    const clock = fakeClock();
    const log = createUsageLog("sess-1", clock.now);

    log.record(usage(100, 40));
    log.record(usage(60, 25));

    const entry = log.snapshot();
    expect(entry.turns).toBe(2);
    expect(entry.inputTokens).toBe(160);
    expect(entry.outputTokens).toBe(65);
    expect(entry.totalTokens).toBe(225);
  });

  it("counts reconnects, errors, and tool calls", () => {
    const log = createUsageLog("sess-2", fakeClock().now);

    log.record({ type: "connection-state", state: "connecting" });
    log.record({ type: "connection-state", state: "connected" });
    log.record({ type: "connection-state", state: "reconnecting" });
    log.record({ type: "connection-state", state: "connected", attempt: 3 });
    log.record({ type: "tool-started", toolName: "get_weather", args: {} });
    log.record({ type: "run-failed", error: new Error("boom") });

    const entry = log.snapshot();
    // One drop and one recovery is one reconnect, however many events the SDK used to say so.
    expect(entry.reconnects).toBe(1);
    expect(entry.errors).toBe(1);
    expect(entry.toolsInvoked).toBe(1);
    expect(entry.transports).toContain("connected");
  });

  it("counts a second drop separately", () => {
    const log = createUsageLog("sess-3", fakeClock().now);
    log.record({ type: "connection-state", state: "connected", attempt: 2 });
    log.record({ type: "connection-state", state: "reconnecting" });
    log.record({ type: "connection-state", state: "connected", attempt: 2 });
    expect(log.snapshot().reconnects).toBe(2);
  });

  it("does not count a drop that never recovered", () => {
    const log = createUsageLog("sess-3b", fakeClock().now);
    log.record({ type: "connection-state", state: "reconnecting" });
    log.record({ type: "connection-state", state: "failed" });
    expect(log.snapshot().reconnects).toBe(0);
  });

  it("reports elapsed time from creation to the snapshot", () => {
    const clock = fakeClock();
    const log = createUsageLog("sess-4", clock.now);
    clock.advance(45_000);
    const entry = log.snapshot();
    expect(entry.durationMs).toBe(45_000);
    expect(entry.sessionId).toBe("sess-4");
  });

  it("counts every event it sees", () => {
    const log = createUsageLog("sess-5", fakeClock().now);
    log.record({ type: "user-speech-started" });
    log.record(usage(1, 1));
    log.record({ type: "agent-speech-ended" });
    expect(log.snapshot().events).toBe(3);
  });
});

describe("redaction", () => {
  it("truncates long strings and reports the original length", () => {
    const long = "x".repeat(900);
    const out = truncate(long);
    expect(out).toContain("truncated 900 chars");
    expect(out.length).toBeLessThan(long.length);
  });

  it("leaves short strings untouched", () => {
    expect(truncate("hello")).toBe("hello");
  });

  it("redacts secret-looking keys at any depth", () => {
    const redacted = redactObject({
      apiKey: "sk-real-value",
      nested: { authorization: "Bearer abc", sessionId: "sess-1" },
      list: [{ OPENAI_API_KEY: "sk-2" }],
    });
    expect(redacted.apiKey).toBe("[redacted]");
    expect((redacted.nested as Record<string, unknown>).authorization).toBe("[redacted]");
    expect((redacted.nested as Record<string, unknown>).sessionId).toBe("sess-1");
    expect((redacted.list as Record<string, unknown>[])[0].OPENAI_API_KEY).toBe("[redacted]");
  });

  it("leaves free text alone, because a transcript is not a secret store", () => {
    // Redaction keys off field names, not content. Scanning every string for key-shaped substrings
    // would mangle ordinary conversation, and the values that matter all arrive under known keys.
    expect(redactObject({ note: "the key is sk-live-123" }).note).toBe("the key is sk-live-123");
  });
});

describe("usage reporting", () => {
  const entry = {
    ...createUsageLog("sess-9", fakeClock().now).snapshot(),
    turns: 3,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    transports: ["connected"],
  };

  it("posts the fields the endpoint accepts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const ok = await postUsage(entry, { fetchImpl, context: { voice: "marin", language: "en-US" } });

    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/usage");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ sessionId: "sess-9", turns: 3, totalTokens: 15, voice: "marin", language: "en-US" });
  });

  it("omits optional context that was not supplied", () => {
    const payload = toUsagePayload(entry);
    expect(payload).not.toHaveProperty("voice");
    expect(payload).not.toHaveProperty("persona");
  });

  it("reports failure without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    await expect(postUsage(entry, { fetchImpl })).resolves.toBe(false);
  });

  it("swallows a network error so a finished conversation is not disturbed", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(postUsage(entry, { fetchImpl })).resolves.toBe(false);
  });
});

describe("sentry bridge", () => {
  beforeEach(() => {
    resetSentryForTests();
  });

  it("stays disabled when no DSN is configured", async () => {
    delete process.env.SENTRY_DSN;
    const loader = vi.fn();
    await expect(initSentry(loader)).resolves.toBe(false);
    expect(loader).not.toHaveBeenCalled();
    expect(sentryEnabled()).toBe(false);
  });

  it("forwards exceptions with a redacted context once initialised", async () => {
    process.env.SENTRY_DSN = "https://example@o1.ingest.sentry.io/2";
    const captureExceptionSpy = vi.fn();
    const client = { captureException: captureExceptionSpy, captureMessage: vi.fn() };
    await initSentry(async () => client);

    expect(sentryEnabled()).toBe(true);
    captureException(new Error("boom"), { apiKey: "sk-live" });
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    expect(captureExceptionSpy.mock.calls[0][1]).toEqual({ apiKey: "[redacted]" });
  });

  it("degrades to a no-op when the package is not installed", async () => {
    process.env.SENTRY_DSN = "https://example@o1.ingest.sentry.io/2";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      initSentry(async () => {
        throw new Error("Cannot find module '@sentry/nextjs'");
      }),
    ).resolves.toBe(false);
    expect(sentryEnabled()).toBe(false);
    expect(() => captureException(new Error("boom"))).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it("initialises only once", async () => {
    process.env.SENTRY_DSN = "https://example@o1.ingest.sentry.io/2";
    const loader = vi.fn(async () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
    await initSentry(loader);
    await initSentry(loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
