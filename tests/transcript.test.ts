import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { installBrowserStubs } from "./helpers/browser-stubs";

/**
 * Transcript behaviour.
 *
 * The interesting requirement is honesty: a response the user cut off must not read as though it
 * finished. These tests drive the hook's event stream and check the resulting entries.
 */

let fakeProvider: import("./helpers/fake-realtime").FakeRealtimeProvider;

vi.mock("samai-sdk/voice", async () => {
  const actual = await vi.importActual<typeof import("samai-sdk/voice")>("samai-sdk/voice");
  return { ...actual, openaiRealtime: () => fakeProvider };
});

import { vi } from "vitest";
import { useVoiceSession } from "@/lib/voice/use-voice-session";

async function startSession() {
  const { FakeRealtimeProvider } = await import("./helpers/fake-realtime");
  fakeProvider = new FakeRealtimeProvider();
  installBrowserStubs();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ clientSecret: "ek", expiresAt: null, model: "gpt-realtime", voice: "marin" }), { status: 200 })),
  );

  const { result, unmount } = renderHook(() => useVoiceSession());
  await act(async () => {
    await result.current.start();
  });
  act(() => fakeProvider.latest.emitConnected());
  return { result, unmount, session: fakeProvider.latest };
}

describe("transcript", () => {
  it("records user and assistant turns as they are recognised", async () => {
    const { result, unmount } = await startSession();

    act(() => {
      fakeProvider.latest.emitUserTurn("what does this product do");
      fakeProvider.latest.emitAssistantTurn("It helps teams understand usage");
    });

    const user = result.current.transcript.find((e) => e.role === "user");
    const assistant = result.current.transcript.find((e) => e.role === "assistant");
    expect(user?.text.trim()).toBe("what does this product do");
    expect(user?.status).toBe("final");
    expect(assistant?.text.trim()).toBe("It helps teams understand usage");
    expect(assistant?.status).toBe("final");

    unmount();
  });

  it("streams partial text while the assistant is still speaking", async () => {
    const { result, unmount } = await startSession();

    act(() => fakeProvider.latest.emitAssistantSpeech("The product is"));
    expect(result.current.transcript.find((e) => e.role === "assistant")?.status).toBe("streaming");

    act(() => {
      fakeProvider.latest.emit({ type: "assistant-transcript-delta", delta: " designed to" });
    });
    // One entry, appended — not a new entry per delta.
    const assistantEntries = result.current.transcript.filter((e) => e.role === "assistant");
    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0].text).toMatch(/designed to$/);

    unmount();
  });

  it("marks a cut-off response as interrupted and keeps the words actually spoken", async () => {
    const { result, unmount } = await startSession();

    act(() => {
      fakeProvider.latest.emitUserTurn("tell me about the product");
      fakeProvider.latest.emitAssistantSpeech("The product is designed to");
    });
    // User interrupts.
    act(() => fakeProvider.latest.emitUserSpeechStarted(true));

    const interrupted = result.current.transcript.find((e) => e.role === "assistant");
    expect(interrupted?.status).toBe("interrupted");
    expect(interrupted?.interrupted).toBe(true);
    // What was spoken is preserved, and not padded out with words never said.
    expect(interrupted?.text).toMatch(/^The product is designed to$/);

    unmount();
  });

  it("continues the transcript after an interruption rather than truncating history", async () => {
    const { result, unmount } = await startSession();

    act(() => {
      fakeProvider.latest.emitUserTurn("tell me about pricing");
      fakeProvider.latest.emitAssistantSpeech("Sure, the plans are");
      fakeProvider.latest.emitUserSpeechStarted(true);
      fakeProvider.latest.emitUserTurn("no I mean API pricing");
      fakeProvider.latest.emitAssistantTurn("API pricing is per thousand units");
    });

    const entries = result.current.transcript;
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(entries[1].interrupted).toBe(true);
    expect(entries[3].status).toBe("final");
    expect(entries[3].text.trim()).toBe("API pricing is per thousand units");

    unmount();
  });

  it("does not duplicate entries across repeated finalisation events", async () => {
    const { result, unmount } = await startSession();

    act(() => fakeProvider.latest.emitAssistantTurn("one complete answer"));
    // A late duplicate of the same terminal events must not create a second entry.
    act(() => {
      fakeProvider.latest.emit({ type: "assistant-transcript-done", transcript: "one complete answer" });
      fakeProvider.latest.emit({ type: "response-cancelled" });
    });

    expect(result.current.transcript.filter((e) => e.role === "assistant")).toHaveLength(1);
    unmount();
  });

  it("timestamps every entry", async () => {
    const { result, unmount } = await startSession();
    act(() => fakeProvider.latest.emitUserTurn("hello"));
    for (const entry of result.current.transcript) {
      expect(entry.startedAt).toBeGreaterThan(0);
      expect(Number.isFinite(entry.startedAt)).toBe(true);
    }
    unmount();
  });

  it("starts each new conversation with a clean transcript", async () => {
    const { result, unmount } = await startSession();
    act(() => fakeProvider.latest.emitUserTurn("first conversation"));
    expect(result.current.transcript.length).toBeGreaterThan(0);

    await act(async () => {
      await result.current.stop();
    });
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.transcript).toEqual([]);
    unmount();
  });
});