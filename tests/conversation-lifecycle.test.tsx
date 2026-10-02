import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { installBrowserStubs, denyMicrophone } from "./helpers/browser-stubs";

/**
 * Conversation lifecycle tests.
 *
 * These drive the app's session hook against a fake realtime provider, so the state machine,
 * interruption handling, reconnect policy, and resource cleanup are all exercised without an OpenAI
 * connection. They verify *orchestration*; the wire protocol itself is verified separately against a
 * local WebSocket server in the SDK's own suite.
 */

const provider = { connect: vi.fn() };
let fakeProvider: import("./helpers/fake-realtime").FakeRealtimeProvider;

vi.mock("samai-sdk/voice", async () => {
  const actual = await vi.importActual<typeof import("samai-sdk/voice")>("samai-sdk/voice");
  return {
    ...actual,
    openaiRealtime: (config: Record<string, unknown>) => {
      provider.connect(config);
      return fakeProvider;
    },
  };
});

/** Successful ephemeral-credential response. */
function mockSessionRoute(ok = true) {
  const fetchMock = vi.fn(async () => {
    if (!ok) return new Response(JSON.stringify({ error: "auth_failed", message: "no key" }), { status: 500 });
    return new Response(
      JSON.stringify({ clientSecret: "ek_test", expiresAt: null, model: "gpt-realtime", voice: "marin" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function importHook() {
  return (await import("@/lib/voice/use-voice-session")).useVoiceSession;
}

beforeEach(async () => {
  vi.resetModules();
  const { FakeRealtimeProvider } = await import("./helpers/fake-realtime");
  fakeProvider = new FakeRealtimeProvider();
  installBrowserStubs();
  mockSessionRoute();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connection lifecycle", () => {
  it("start → requests the microphone → connects → listening", async () => {
    const { getUserMedia } = installBrowserStubs();
    const useVoiceSession = await importHook();
    const { result } = renderHook(() => useVoiceSession());

    expect(result.current.state).toBe("idle");

    await act(async () => {
        await result.current.start();
    });

    act(() => fakeProvider.latest.emitConnected());

    // Microphone was requested only because the user asked to start.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({ video: false });
    expect(result.current.isActive).toBe(true);
    expect(result.current.error).toBeNull();
    expect(fakeProvider.sessions).toHaveLength(1);
  });

  it("does not request the microphone before the user starts", async () => {
    const { getUserMedia } = installBrowserStubs();
    const useVoiceSession = await importHook();
    renderHook(() => useVoiceSession());
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("reports a clear error when microphone permission is denied", async () => {
    denyMicrophone();
    const useVoiceSession = await importHook();
    const { result } = renderHook(() => useVoiceSession());

    await act(async () => {
        await result.current.start();
    });

    expect(result.current.state).toBe("error");
    expect(result.current.error?.kind).toBe("permission_denied");
    expect(result.current.error?.message).toMatch(/microphone access is required/i);
    // No raw browser error text leaks into the UI.
    expect(result.current.error?.message).not.toMatch(/notallowed/i);
    expect(fakeProvider.sessions).toHaveLength(0);
  });

  it("does not create a session when the credential request fails", async () => {
    installBrowserStubs();
    mockSessionRoute(false);
    const useVoiceSession = await importHook();
    const { result } = renderHook(() => useVoiceSession());

    await act(async () => {
        await result.current.start();
    });

    expect(result.current.state).toBe("error");
    expect(fakeProvider.sessions).toHaveLength(0);
  });
});

describe("turn taking", () => {
  it("user speaks → thinking → assistant speaks → listening", async () => {
    installBrowserStubs();
    const useVoiceSession = await importHook();
    const { result } = renderHook(() => useVoiceSession());

    await act(async () => {
        await result.current.start();
    });

    act(() => fakeProvider.latest.emitConnected());

    // User starts talking.
    act(() => fakeProvider.latest.emitUserSpeechStarted());
    expect(result.current.state).toBe("user_speaking");
    expect(result.current.turnOwner).toBe("user");

    // User stops; turn detection hands over to the assistant.
    act(() => fakeProvider.latest.emitUserTurn("what time is it"));
    expect(result.current.state).toBe("thinking");
    expect(result.current.turnOwner).toBe("none");

    // Assistant responds.
    act(() => fakeProvider.latest.emitAssistantSpeech("It is ten thirty"));
    expect(result.current.state).toBe("assistant_speaking");
    expect(result.current.turnOwner).toBe("assistant");

    // Assistant finishes; back to listening for the next turn.
    act(() => {
      fakeProvider.latest.emit({ type: "assistant-transcript-done", transcript: "It is ten thirty" });
      fakeProvider.latest.emit({ type: "agent-speech-ended" });
    });
    expect(result.current.state).toBe("listening");
  });

  it("supports multiple consecutive turns without re-connecting", async () => {
    installBrowserStubs();
    const useVoiceSession = await importHook();
    const { result } = renderHook(() => useVoiceSession());

    await act(async () => {
        await result.current.start();
    });

    act(() => fakeProvider.latest.emitConnected());

    for (let turn = 0; turn < 3; turn++) {
      act(() => fakeProvider.latest.emitUserTurn(`question ${turn}`));
      act(() => fakeProvider.latest.emitAssistantTurn(`answer ${turn}`));
    }

    expect(result.current.state).toBe("listening");
    expect(fakeProvider.sessions).toHaveLength(1);
    const userTurns = result.current.transcript.filter((e) => e.role === "user");
    const assistantTurns = result.current.transcript.filter((e) => e.role === "assistant");
    expect(userTurns).toHaveLength(3);
    expect(assistantTurns).toHaveLength(3);
  });
});

describe("interruption (barge-in)", () => {
  it("assistant speaking → user speaks → assistant stops → user turn continues", async () => {
    installBrowserStubs();
    const useVoiceSession = await importHook();
    const { result } = renderHook(() => useVoiceSession());

    await act(async () => {
        await result.current.start();
    });

    act(() => fakeProvider.latest.emitConnected());

    // Assistant starts a sentence.
    act(() => {
      fakeProvider.latest.emitUserTurn("tell me about the product");
      fakeProvider.latest.emitAssistantSpeech("The product is designed to");
    });
    expect(result.current.state).toBe("assistant_speaking");

    // User talks over it. No stop button involved.
    act(() => fakeProvider.latest.emitUserSpeechStarted(true));
    expect(result.current.state).toBe("user_speaking");

    // The interrupted response is recorded as cut off, not as completed.
    const interrupted = result.current.transcript.find((e) => e.role === "assistant" && e.interrupted);
    expect(interrupted).toBeDefined();
    expect(interrupted?.status).toBe("interrupted");

    // The user's continued utterance becomes the current turn.
    act(() => fakeProvider.latest.emitUserTurn("wait what does designed mean"));
    expect(result.current.state).toBe("thinking");

    // And the assistant answers the new request.
    act(() => fakeProvider.latest.emitAssistantTurn("designed means it was built for"));
    expect(result.current.state).toBe("listening");

    const assistantEntries = result.current.transcript.filter((e) => e.role === "assistant");
    expect(assistantEntries).toHaveLength(2);
    expect(assistantEntries[0].interrupted).toBe(true);
    expect(assistantEntries[1].interrupted).toBeUndefined();
  });

  it("handles several interruptions in a row", async () => {
    installBrowserStubs();
    const useVoiceSession = await importHook();
    const { result } = renderHook(() => useVoiceSession());

    await act(async () => {
        await result.current.start();
    });

    act(() => fakeProvider.latest.emitConnected());

    act(() => {
      fakeProvider.latest.emitUserTurn("tell me about pricing");
      fakeProvider.latest.emitAssistantSpeech("Sure, the pricing is");
      fakeProvider.latest.emitUserSpeechStarted(true);
      fakeProvider.latest.emitUserTurn("no I mean API pricing");
      fakeProvider.latest.emitAssistantSpeech("API pricing is");
      fakeProvider.latest.emitUserSpeechStarted(true);
      fakeProvider.latest.emitUserTurn("actually forget it");
      fakeProvider.latest.emitAssistantTurn("No problem.");
    });

    expect(result.current.state).toBe("listening");
    const interrupted = result.current.transcript.filter((e) => e.role === "assistant" && e.interrupted);
    expect(interrupted).toHaveLength(2);
    // Only the last assistant response is complete.
    expect(result.current.transcript.filter((e) => e.role === "assistant" && e.status === "final")).toHaveLength(1);
  });

  it("does not mark an assistant response interrupted when the user is not speaking", async () => {
    installBrowserStubs();
    const useVoiceSession = await importHook();
    const { result } = renderHook(() => useVoiceSession());

    await act(async () => {
        await result.current.start();
    });

    act(() => fakeProvider.latest.emitConnected());

    act(() => {
      fakeProvider.latest.emitUserTurn("hello");
      fakeProvider.latest.emitAssistantTurn("Hi, how can I help?");
    });

    const assistantEntry = result.current.transcript.find((e) => e.role === "assistant");
    expect(assistantEntry?.interrupted).toBeUndefined();
    expect(assistantEntry?.status).toBe("final");
  });
});

describe("reconnect", () => {
  it("connection lost → reconnecting → connected", async () => {
    vi.useFakeTimers();
    try {
      installBrowserStubs();
      const useVoiceSession = await importHook();
      const { result } = renderHook(() => useVoiceSession());

      await act(async () => {
          await result.current.start();
      });

      act(() => fakeProvider.latest.emitConnected());
      expect(result.current.state).toBe("listening");
      expect(fakeProvider.sessions).toHaveLength(1);

      // Have a real exchange, so the reconnect has context to preserve.
      act(() => {
        fakeProvider.latest.emitUserTurn("hello there");
        fakeProvider.latest.emitAssistantTurn("Hi, how can I help?");
      });
      const before = result.current.transcript.length;
      expect(before).toBeGreaterThan(0);

      // Drop the connection mid-conversation.
      act(() => fakeProvider.latest.emit({ type: "connection-state", state: "failed" }));
      expect(result.current.state).toBe("reconnecting");

      // Backoff fires, a fresh ephemeral credential is minted, and a new session is established.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(fakeProvider.sessions).toHaveLength(2);
      expect(result.current.error).toBeNull();
      // The transcript survives the reconnect.
      expect(result.current.transcript.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after a bounded number of attempts instead of looping forever", async () => {
    vi.useFakeTimers();
    try {
      installBrowserStubs();
      const useVoiceSession = await importHook();
      const { result } = renderHook(() => useVoiceSession());

      await act(async () => {
          await result.current.start();
      });

      act(() => fakeProvider.latest.emitConnected());

      // Every subsequent attempt fails.
      fakeProvider.failAllConnects = new Error("connection failed");

      act(() => fakeProvider.latest.emit({ type: "connection-state", state: "failed" }));
      for (let i = 0; i < 6; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20000);
        });
      }

      expect(result.current.state).toBe("error");
      expect(result.current.error?.message).toMatch(/could not reconnect/i);
      // Bounded: initial connect plus at most 3 retries.
      expect(fakeProvider.sessions.length).toBeLessThanOrEqual(1 + 3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cleanup", () => {
  it("end conversation → releases audio, closes the session, returns to idle", async () => {
    const stubs = installBrowserStubs();
    const useVoiceSession = await importHook();
    const { result } = renderHook(() => useVoiceSession());

    await act(async () => {
        await result.current.start();
    });

    act(() => fakeProvider.latest.emitConnected());

    const context = stubs.contexts[0];
    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.state).toBe("idle");
    expect(result.current.isActive).toBe(false);
    expect(fakeProvider.latest.closed).toBe(true);
    // Media tracks stopped → the browser's microphone indicator goes away.
    expect(stubs.tracks.every((t) => t.stopped)).toBe(true);
    // AudioContext released.
    expect(context?.closed).toBe(true);
    // Analyser nodes disconnected.
    expect(context?.analysers.every((a) => !a.connected) ?? true).toBe(true);
  });

  it("prevents duplicate sessions when start is called twice", async () => {
    installBrowserStubs();
    const useVoiceSession = await importHook();
    const { result } = renderHook(() => useVoiceSession());

    await act(async () => {
      await result.current.start();
      await result.current.start();
    });

    expect(fakeProvider.sessions).toHaveLength(1);
    await act(async () => {
      await result.current.stop();
    });
    // Every session that was created is closed again.
    expect(fakeProvider.sessions.every((s) => s.closed)).toBe(true);
  });

  it("stops listening once the conversation ends", async () => {
    installBrowserStubs();
    const useVoiceSession = await importHook();
    const { result } = renderHook(() => useVoiceSession());

    await act(async () => {
        await result.current.start();
    });

    act(() => fakeProvider.latest.emitConnected());

    const session = fakeProvider.latest;
    await act(async () => {
      await result.current.stop();
    });

    // Events arriving after teardown are ignored rather than resurrecting a dead conversation.
    act(() => {
      session.emit({ type: "connection-state", state: "connected" });
    });
    expect(result.current.state).toBe("idle");
  });
});