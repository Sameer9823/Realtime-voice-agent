import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowserStubs } from "./helpers/browser-stubs";
import { useVoiceSession } from "@/lib/voice/use-voice-session";

/**
 * Microphone gating: mute and push-to-talk.
 *
 * Both gate the *same* mechanism — the capture flag on the audio track — rather than closing and
 * reopening the stream. That is what lets unmuting work without a fresh permission grant, so these
 * assert on the track's `enabled` flag rather than on `getUserMedia` call counts.
 */

const ORIGINAL_ENV = { ...process.env };

function stubSessionResponse() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            clientSecret: "ek_test",
            expiresAt: null,
            model: "gpt-realtime",
            voice: "marin",
            instructions: "You are a voice assistant.",
            personaId: "friendly",
            language: "auto",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
}

let browser: ReturnType<typeof installBrowserStubs>;

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  browser = installBrowserStubs();
  stubSessionResponse();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function startedHook() {
  const rendered = renderHook(() => useVoiceSession());
  await act(async () => {
    await rendered.result.current.start();
  });
  return rendered;
}

describe("mute", () => {
  it("disables capture while muted and restores it on unmute", async () => {
    const { result } = await startedHook();
    const track = browser.tracks[0]!;
    expect(track.enabled).toBe(true);

    act(() => result.current.setMuted(true));
    expect(result.current.muted).toBe(true);
    expect(track.enabled).toBe(false);

    act(() => result.current.setMuted(false));
    expect(track.enabled).toBe(true);
  });

  it("leaves the stream open while muted so unmuting needs no new permission", async () => {
    const { result } = await startedHook();
    const track = browser.tracks[0]!;

    act(() => result.current.setMuted(true));
    act(() => result.current.setMuted(false));

    // One permission request for the whole conversation, mute included, and the track was never
    // stopped - otherwise unmuting would need a fresh prompt.
    expect(browser.getUserMedia).toHaveBeenCalledTimes(1);
    expect(track.stopped).toBe(false);
  });
});

describe("push to talk", () => {
  it("opens capture only while the key is held", async () => {
    const { result } = await startedHook();
    const track = browser.tracks[0]!;

    act(() => result.current.setPushToTalk(true));
    // Enabling the mode closes the gate immediately rather than waiting for the next press.
    expect(track.enabled).toBe(false);

    act(() => result.current.setTalking(true));
    expect(track.enabled).toBe(true);

    act(() => result.current.setTalking(false));
    expect(track.enabled).toBe(false);
  });

  it("ignores a press while the mode is off", async () => {
    const { result } = await startedHook();
    const track = browser.tracks[0]!;

    act(() => result.current.setTalking(true));

    expect(result.current.talking).toBe(false);
    expect(track.enabled).toBe(true);
  });

  it("releases the gate when push-to-talk is switched off mid-press", async () => {
    const { result } = await startedHook();
    const track = browser.tracks[0]!;

    act(() => result.current.setPushToTalk(true));
    act(() => result.current.setTalking(true));
    act(() => result.current.setPushToTalk(false));

    // Otherwise turning the mode off while holding would leave the microphone open with no
    // visible control holding it.
    expect(result.current.talking).toBe(false);
    expect(track.enabled).toBe(true);
  });

  it("keeps mute winning over push-to-talk", async () => {
    const { result } = await startedHook();
    const track = browser.tracks[0]!;

    act(() => result.current.setMuted(true));
    act(() => result.current.setPushToTalk(true));
    act(() => result.current.setTalking(true));

    // Mute is the stronger signal: holding the key must not unmute a muted microphone.
    expect(track.enabled).toBe(false);
  });

  it("starts a new session closed rather than leaving a previous press latched", async () => {
    const { result } = await startedHook();
    const first = browser.tracks[0]!;

    act(() => result.current.setPushToTalk(true));
    act(() => result.current.setTalking(true));
    expect(first.enabled).toBe(true);

    await act(async () => {
      await result.current.stop();
    });

    // A fresh stub, so the second session has its own track to inspect.
    browser = installBrowserStubs();
    stubSessionResponse();
    await act(async () => {
      await result.current.start();
    });

    // A stale press from the previous conversation must not carry over.
    expect(result.current.talking).toBe(false);
    expect(browser.tracks[0]!.enabled).toBe(false);
  });
});

describe("typed turns", () => {
  it("refuses to send when no session is live", () => {
    const { result } = renderHook(() => useVoiceSession());
    expect(result.current.sendText("hello")).toBe(false);
  });

  it("refuses blank input", () => {
    const { result } = renderHook(() => useVoiceSession());
    expect(result.current.sendText("   ")).toBe(false);
    expect(result.current.sendText("")).toBe(false);
  });

  it("sends a typed turn through a live session", async () => {
    const { result } = await startedHook();
    // The SDK's session does implement sendText, so a typed turn reaches the transport rather
    // than being rejected. This is the same code path the text box uses.
    expect(result.current.sendText("what is the weather?")).toBe(true);
  });

  it("trims a typed turn before sending", async () => {
    const { result } = await startedHook();
    expect(result.current.sendText("  hello  ")).toBe(true);
  });
});