import { describe, expect, it } from "vitest";
import { detectCapabilities, toVoiceError } from "@/lib/voice/use-voice-session";
import { installBrowserStubs, denyMicrophone, missingMicrophone } from "./helpers/browser-stubs";

/**
 * Error mapping and capability detection.
 *
 * The rule being tested: whatever the browser or OpenAI throws, the interface only ever shows a
 * sentence written for a person — never a raw exception, status code, or stack trace.
 */

describe("toVoiceError", () => {
  it("maps a denied microphone to a permission error", () => {
    const error = toVoiceError(denyMicrophone());
    expect(error.kind).toBe("permission_denied");
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/microphone access is required/i);
  });

  it("maps a missing device to a non-retryable error", () => {
    const error = toVoiceError(missingMicrophone());
    expect(error.kind).toBe("microphone_unavailable");
    expect(error.retryable).toBe(false);
  });

  it("recognises an unplugged microphone", () => {
    const error = toVoiceError(new Error("Could not start track. NotReadableError: Device has been lost."));
    expect(error.kind).toBe("audio_capture_failed");
  });

  it("recognises missing WebRTC support", () => {
    const error = toVoiceError(new Error("This browser does not support WebRTC, which the Realtime API requires."));
    expect(error.kind).toBe("unsupported_browser");
    expect(error.retryable).toBe(false);
  });

  it("maps an authentication failure", () => {
    expect(toVoiceError(new Error("Request failed with status 401")).kind).toBe("auth_failed");
  });

  it("maps rate limiting", () => {
    expect(toVoiceError(new Error("429 Too Many Requests")).kind).toBe("rate_limited");
  });

  it("maps an unavailable model", () => {
    expect(toVoiceError(new Error("The model gpt-realtime is not available")).kind).toBe("model_unavailable");
  });

  it("maps transport failures", () => {
    expect(toVoiceError(new Error("WebRTC ICE negotiation failed")).kind).toBe("connection_failed");
    expect(toVoiceError(new Error("Failed to fetch")).kind).toBe("connection_failed");
  });

  it("falls back to a safe generic message", () => {
    const error = toVoiceError(new Error("x".repeat(400)));
    expect(error.kind).toBe("unknown");
    expect(error.message).not.toContain("xxxx");
  });

  it("never leaks internal detail into the message", () => {
    const leaky = [
      new Error("NotAllowedError: Permission denied at /app/api/realtime/session/route.ts:42"),
      new Error("TypeError: undefined is not a function (evaluating 'Buffer.from(x)')"),
      new Error("ek_test_abc123 is invalid"),
    ];
    for (const raw of leaky) {
      const error = toVoiceError(raw);
      expect(error.message).not.toMatch(/route\.ts/);
      expect(error.message).not.toMatch(/Buffer/);
      expect(error.message).not.toMatch(/ek_test/);
      expect(error.message).not.toMatch(/\bat \/|\.ts:\d+/);
    }
  });

  it("handles non-Error throwables", () => {
    expect(toVoiceError("something went wrong").kind).toBe("unknown");
    expect(toVoiceError(undefined).kind).toBe("unknown");
    expect(toVoiceError(null).kind).toBe("unknown");
  });
});

describe("detectCapabilities", () => {
  it("reports support when the browser has everything it needs", () => {
    installBrowserStubs();
    const caps = detectCapabilities();
    expect(caps.supported).toBe(true);
    expect(caps.getUserMedia).toBe(true);
    expect(caps.webRTC).toBe(true);
    expect(caps.audioContext).toBe(true);
    expect(caps.missing).toEqual([]);
  });

  it("reports missing WebRTC and does not crash", () => {
    installBrowserStubs();
    delete (globalThis as Record<string, unknown>).RTCPeerConnection;
    const caps = detectCapabilities();
    expect(caps.supported).toBe(false);
    expect(caps.webRTC).toBe(false);
    expect(caps.missing.join(" ")).toMatch(/webrtc/i);
  });

  it("reports missing microphone access without crashing", () => {
    installBrowserStubs();
    Object.defineProperty(globalThis.navigator, "mediaDevices", { configurable: true, writable: true, value: undefined });
    const caps = detectCapabilities();
    expect(caps.supported).toBe(false);
    expect(caps.getUserMedia).toBe(false);
  });

  it("reports missing Web Audio without crashing", () => {
    installBrowserStubs();
    delete (globalThis as Record<string, unknown>).AudioContext;
    const caps = detectCapabilities();
    expect(caps.supported).toBe(false);
    expect(caps.missing.join(" ")).toMatch(/web audio/i);
  });
});