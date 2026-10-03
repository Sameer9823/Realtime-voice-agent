import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtendedControls } from "@/components/voice/ExtendedControls";
import { AudioUnlockPrompt } from "@/components/voice/AudioUnlockPrompt";
import type { TranscriptEntry } from "@/lib/voice/types";
import type { MediaDevicesResult } from "@/lib/voice/use-media-devices";
import { formatCountdown } from "@/lib/voice/use-session-limits";

/**
 * Session controls: mute, push-to-talk, device pickers, typed turns, and transcript export.
 *
 * Push-to-talk is driven from a real window listener, so the keyboard path is exercised by
 * dispatching key events rather than by calling the handler directly — otherwise the binding
 * itself would be untested.
 */

function devices(overrides: Partial<MediaDevicesResult> = {}): MediaDevicesResult {
  return {
    inputs: [],
    outputs: [],
    selectedInputId: "",
    selectedOutputId: "",
    canSelectOutput: false,
    refresh: vi.fn(async () => {}),
    selectInput: vi.fn(),
    selectOutput: vi.fn(async () => true),
    applyOutput: vi.fn(async () => true),
    ...overrides,
  };
}

function renderControls(props: Partial<React.ComponentProps<typeof ExtendedControls>> = {}) {
  const callbacks = {
    onMutedChange: vi.fn(),
    onPushToTalkChange: vi.fn(),
    onTalkingChange: vi.fn(),
    onSendText: vi.fn(() => true),
  };
  render(
    <ExtendedControls
      active
      muted={false}
      pushToTalk={false}
      talking={false}
      transcript={[]}
      devices={devices()}
      remainingMs={null}
      idleWarning={false}
      formatCountdown={formatCountdown}
      {...callbacks}
      {...props}
    />,
  );
  return callbacks;
}

const ENTRIES: TranscriptEntry[] = [
  { id: "1", role: "user", text: "What is the weather?", status: "final", startedAt: Date.now() },
  { id: "2", role: "assistant", text: "It is sunny.", status: "final", startedAt: Date.now() },
];

describe("mute", () => {
  it("toggles and reports the pressed state", () => {
    const { onMutedChange } = renderControls();

    const mute = screen.getByRole("button", { name: "Mute microphone" });
    expect(mute.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(mute);
    expect(onMutedChange).toHaveBeenCalledWith(true);
  });

  it("offers unmute once muted", () => {
    const { onMutedChange } = renderControls({ muted: true });

    const unmute = screen.getByRole("button", { name: "Unmute microphone" });
    expect(unmute.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(unmute);
    expect(onMutedChange).toHaveBeenCalledWith(false);
  });

  it("is disabled when no session is live", () => {
    renderControls({ active: false });
    expect((screen.getByRole("button", { name: "Mute microphone" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("push to talk", () => {
  it("opens the microphone while Space is held", () => {
    const { onTalkingChange } = renderControls({ pushToTalk: true });

    fireEvent.keyDown(window, { code: "Space" });
    expect(onTalkingChange).toHaveBeenCalledWith(true);

    fireEvent.keyUp(window, { code: "Space" });
    expect(onTalkingChange).toHaveBeenCalledWith(false);
  });

  it("ignores Space auto-repeat so the gate is not re-sent", () => {
    const { onTalkingChange } = renderControls({ pushToTalk: true });

    fireEvent.keyDown(window, { code: "Space" });
    onTalkingChange.mockClear();
    fireEvent.keyDown(window, { code: "Space", repeat: true });

    expect(onTalkingChange).not.toHaveBeenCalled();
  });

  it("closes the microphone when the window loses focus while held", () => {
    // Otherwise tabbing away mid-press would leave the microphone open with no visible button held.
    const { onTalkingChange } = renderControls({ pushToTalk: true });

    fireEvent.keyDown(window, { code: "Space" });
    onTalkingChange.mockClear();
    fireEvent.blur(window);

    expect(onTalkingChange).toHaveBeenCalledWith(false);
  });

  it("does not capture Space while the user is typing", () => {
    const { onTalkingChange } = renderControls({ pushToTalk: true });

    render(<input aria-label="text field" />);
    const input = screen.getByLabelText("text field");

    fireEvent.keyDown(input, { code: "Space" });
    expect(onTalkingChange).not.toHaveBeenCalled();
  });

  it("is inert when the mode is off", () => {
    const { onTalkingChange } = renderControls({ pushToTalk: false });

    fireEvent.keyDown(window, { code: "Space" });
    expect(onTalkingChange).not.toHaveBeenCalled();
  });

  it("is inert when no session is live", () => {
    const { onTalkingChange } = renderControls({ pushToTalk: true, active: false });

    fireEvent.keyDown(window, { code: "Space" });
    expect(onTalkingChange).not.toHaveBeenCalled();
  });

  it("supports holding the button with a pointer", () => {
    const { onTalkingChange } = renderControls({ pushToTalk: true });

    const button = screen.getByRole("button", { name: "Hold to speak" });
    fireEvent.pointerDown(button);
    expect(onTalkingChange).toHaveBeenCalledWith(true);

    fireEvent.pointerUp(button);
    expect(onTalkingChange).toHaveBeenCalledWith(false);
  });

  it("supports the button from the keyboard", () => {
    const { onTalkingChange } = renderControls({ pushToTalk: true });

    const button = screen.getByRole("button", { name: "Hold to speak" });
    fireEvent.keyDown(button, { key: " " });
    expect(onTalkingChange).toHaveBeenCalledWith(true);

    fireEvent.keyUp(button, { key: " " });
    expect(onTalkingChange).toHaveBeenCalledWith(false);
  });

  it("reflects the talking state in its label", () => {
    renderControls({ pushToTalk: true, talking: true });
    expect(screen.getByRole("button", { name: "Microphone is open, release to close" })).toBeTruthy();
  });
});

describe("device pickers", () => {
  it("are hidden when there is only one device", () => {
    renderControls({ devices: devices({ inputs: [{ deviceId: "a", label: "System default" }] }) });
    expect(screen.queryByLabelText("Microphone")).toBeNull();
  });

  it("list microphones when there is a choice", () => {
    const selectInput = vi.fn();
    renderControls({
      devices: devices({
        inputs: [
          { deviceId: "a", label: "Built-in" },
          { deviceId: "b", label: "Headset" },
        ],
        selectedInputId: "a",
        selectInput,
      }),
    });

    const picker = screen.getByLabelText("Microphone") as HTMLSelectElement;
    expect(picker.value).toBe("a");

    fireEvent.change(picker, { target: { value: "b" } });
    expect(selectInput).toHaveBeenCalledWith("b");
  });

  it("omit the speaker picker where setSinkId is unsupported", () => {
    renderControls({ devices: devices({ canSelectOutput: false, outputs: [{ deviceId: "s", label: "Speakers" }] }) });
    expect(screen.queryByLabelText("Speaker")).toBeNull();
  });

  it("list speakers where setSinkId is supported", () => {
    renderControls({
      devices: devices({
        canSelectOutput: true,
        outputs: [
          { deviceId: "s1", label: "Speakers" },
          { deviceId: "s2", label: "Headphones" },
        ],
        selectedOutputId: "s1",
      }),
    });

    expect(screen.getByLabelText("Speaker")).toBeTruthy();
  });
});

describe("typed turns", () => {
  it("sends the trimmed text and clears the field", () => {
    const { onSendText } = renderControls();

    const input = screen.getByLabelText("Type instead of speaking") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  hello there  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send typed message" }));

    expect(onSendText).toHaveBeenCalledWith("hello there");
    expect(input.value).toBe("");
  });

  it("keeps the text when the send fails, so it is not lost", () => {
    // A failed send means no live session; silently clearing would discard what was typed.
    const send = vi.fn(() => false);
    renderControls({ onSendText: send });

    const input = screen.getByLabelText("Type instead of speaking") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send typed message" }));

    expect(send).toHaveBeenCalledWith("keep me");
    expect(input.value).toBe("keep me");
  });

  it("will not send an empty message", () => {
    const { onSendText } = renderControls();
    fireEvent.click(screen.getByRole("button", { name: "Send typed message" }));
    expect(onSendText).not.toHaveBeenCalled();
  });

  it("is disabled when no session is live", () => {
    renderControls({ active: false });
    expect((screen.getByLabelText("Type instead of speaking") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Send typed message" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("transcript export", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("is unavailable with an empty transcript", () => {
    renderControls();
    expect((screen.getByRole("button", { name: "Copy transcript to clipboard" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Download transcript as a text file" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("copies a readable transcript", async () => {
    renderControls({ transcript: ENTRIES });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy transcript to clipboard" }));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toBe("You: What is the weather?\nAssistant: It is sunny.");
  });

  it("marks an interrupted turn in the exported text", async () => {
    renderControls({
      transcript: [{ ...ENTRIES[1]!, text: "It was sunny but", interrupted: true, status: "interrupted" }],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy transcript to clipboard" }));
    });

    expect(writeText.mock.calls[0]![0]).toContain("(interrupted)");
  });

  it("confirms a copy briefly", async () => {
    renderControls({ transcript: ENTRIES });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy transcript to clipboard" }));
    });
    expect(screen.getByRole("button", { name: "Copy transcript to clipboard" }).textContent).toBe("Copied");
  });

  it("survives a denied clipboard without throwing", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    renderControls({ transcript: ENTRIES });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy transcript to clipboard" }));
    });
    // The download path stays available, which is the recovery.
    expect((screen.getByRole("button", { name: "Download transcript as a text file" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("countdown and idle warning", () => {
  it("shows remaining time in a polite live region", () => {
    renderControls({ remainingMs: 65_000 });
    const region = screen.getByRole("status");
    expect(region.textContent).toContain("1:05 left");
  });

  it("hides the countdown when there is no cap", () => {
    renderControls({ remainingMs: null });
    expect(screen.queryByText(/left$/)).toBeNull();
  });

  it("warns before ending an idle session", () => {
    renderControls({ idleWarning: true });
    expect(screen.getByRole("status").textContent).toContain("will end soon");
  });

  it("shows no idle warning when the session is active", () => {
    renderControls({ idleWarning: true, active: false });
    expect(screen.queryByText(/will end soon/)).toBeNull();
  });
});

describe("AudioUnlockPrompt", () => {
  const originalUserAgent = navigator.userAgent;

  afterEach(() => {
    Object.defineProperty(navigator, "userAgent", { value: originalUserAgent, configurable: true });
  });

  function setUserAgent(value: string) {
    Object.defineProperty(navigator, "userAgent", { value, configurable: true });
  }

  it("renders on iOS and unlocks on tap", () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15");
    const onUnlock = vi.fn();
    render(<AudioUnlockPrompt visible onUnlock={onUnlock} />);

    fireEvent.click(screen.getByRole("button", { name: "Tap to enable audio" }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it("stays hidden on desktop, where autoplay is not gated", () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0");
    render(<AudioUnlockPrompt visible onUnlock={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Tap to enable audio" })).toBeNull();
  });

  it("renders nothing when not visible", () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    render(<AudioUnlockPrompt visible={false} onUnlock={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("unlocks on a keypress too", () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    const onUnlock = vi.fn();
    render(<AudioUnlockPrompt visible onUnlock={onUnlock} />);

    fireEvent.keyDown(window);
    expect(onUnlock).toHaveBeenCalled();
  });
});

describe("accessibility", () => {
  it("gives every control an accessible name", () => {
    renderControls({
      transcript: ENTRIES,
      devices: devices({
        inputs: [
          { deviceId: "a", label: "Built-in" },
          { deviceId: "b", label: "Headset" },
        ],
        canSelectOutput: true,
        outputs: [
          { deviceId: "s1", label: "Speakers" },
          { deviceId: "s2", label: "Headphones" },
        ],
      }),
    });

    const region = screen.getByRole("region", { name: "Conversation controls" });
    for (const control of within(region).getAllByRole("button")) {
      const name = control.getAttribute("aria-label") ?? control.textContent ?? "";
      expect(name.trim().length, `unnamed control: ${control.outerHTML.slice(0, 80)}`).toBeGreaterThan(0);
    }
  });

  it("labels the two device selects and the text field", () => {
    renderControls({
      devices: devices({
        inputs: [
          { deviceId: "a", label: "Built-in" },
          { deviceId: "b", label: "Headset" },
        ],
        canSelectOutput: true,
        outputs: [
          { deviceId: "s1", label: "Speakers" },
          { deviceId: "s2", label: "Headphones" },
        ],
      }),
    });

    expect(screen.getByLabelText("Microphone")).toBeTruthy();
    expect(screen.getByLabelText("Speaker")).toBeTruthy();
    expect(screen.getByLabelText("Type instead of speaking")).toBeTruthy();
  });
});