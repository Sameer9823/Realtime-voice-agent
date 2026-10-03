import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionLimits, formatCountdown } from "@/lib/voice/use-session-limits";

/**
 * Session lifetime limits.
 *
 * Timers are faked rather than awaited, so the 10-minute cap and the 60-second idle cut-off are
 * exercised exactly rather than approximated with short test-only thresholds.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("formatCountdown", () => {
  it("formats minutes and seconds", () => {
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(600_000)).toBe("10:00");
    expect(formatCountdown(9_000)).toBe("0:09");
  });

  it("rounds up so a visible countdown never reads 0:00 while time remains", () => {
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(1_001)).toBe("0:02");
  });

  it("never goes negative", () => {
    expect(formatCountdown(-5_000)).toBe("0:00");
  });
});

describe("useSessionLimits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not count before begin()", () => {
    const onMax = vi.fn();
    const { result } = renderHook(() => useSessionLimits({ maxDurationMs: 1000, idleTimeoutMs: 60_000, idleWarningMs: 45_000, onMaxReached: onMax, onIdleEnd: vi.fn() }));

    expect(result.current.remainingMs).toBeNull();
    act(() => void vi.advanceTimersByTime(5000));
    expect(onMax).not.toHaveBeenCalled();
  });

  it("counts down the remaining session time", () => {
    const { result } = renderHook(() => useSessionLimits({ maxDurationMs: 60_000, idleTimeoutMs: 600_000, idleWarningMs: 45_000, onMaxReached: vi.fn(), onIdleEnd: vi.fn() }));

    act(() => result.current.begin());
    expect(result.current.remainingMs).toBe(60_000);

    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current.remainingMs).toBe(50_000);
  });

  it("ends the session at the cap and fires exactly once", () => {
    const onMax = vi.fn();
    const { result } = renderHook(() => useSessionLimits({ maxDurationMs: 60_000, idleTimeoutMs: 600_000, idleWarningMs: 45_000, onMaxReached: onMax, onIdleEnd: vi.fn() }));

    act(() => result.current.begin());
    act(() => void vi.advanceTimersByTime(61_000));

    expect(onMax).toHaveBeenCalledTimes(1);
    expect(result.current.remainingMs).toBe(0);
  });

  it("does not re-fire the cap callback on later ticks", () => {
    const onMax = vi.fn();
    const { result } = renderHook(() => useSessionLimits({ maxDurationMs: 1000, idleTimeoutMs: 600_000, idleWarningMs: 45_000, onMaxReached: onMax, onIdleEnd: vi.fn() }));

    act(() => result.current.begin());
    act(() => void vi.advanceTimersByTime(2000));
    act(() => void vi.advanceTimersByTime(2000));
    act(() => void vi.advanceTimersByTime(2000));

    expect(onMax).toHaveBeenCalledTimes(1);
  });

  it("warns before the idle cut-off", () => {
    const onIdle = vi.fn();
    const { result } = renderHook(() => useSessionLimits({ maxDurationMs: null, idleTimeoutMs: 60_000, idleWarningMs: 45_000, onMaxReached: vi.fn(), onIdleEnd: onIdle }));

    act(() => result.current.begin());

    act(() => void vi.advanceTimersByTime(44_000));
    expect(result.current.idleWarning).toBe(false);
    expect(onIdle).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(2_000));
    expect(result.current.idleWarning).toBe(true);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("ends the session after the idle timeout", () => {
    const onIdle = vi.fn();
    const { result } = renderHook(() => useSessionLimits({ maxDurationMs: null, idleTimeoutMs: 60_000, idleWarningMs: 45_000, onMaxReached: vi.fn(), onIdleEnd: onIdle }));

    act(() => result.current.begin());
    act(() => void vi.advanceTimersByTime(61_000));

    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("activity resets the idle clock", () => {
    const onIdle = vi.fn();
    const { result } = renderHook(() => useSessionLimits({ maxDurationMs: null, idleTimeoutMs: 60_000, idleWarningMs: 45_000, onMaxReached: vi.fn(), onIdleEnd: onIdle }));

    act(() => result.current.begin());
    act(() => void vi.advanceTimersByTime(50_000));
    expect(result.current.idleWarning).toBe(true);

    // The user speaks again.
    act(() => result.current.markActivity());
    expect(result.current.idleMs).toBe(0);
    expect(result.current.idleWarning).toBe(false);

    act(() => void vi.advanceTimersByTime(50_000));
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("activity does not extend the hard cap", () => {
    const onMax = vi.fn();
    const { result } = renderHook(() => useSessionLimits({ maxDurationMs: 30_000, idleTimeoutMs: 600_000, idleWarningMs: 45_000, onMaxReached: onMax, onIdleEnd: vi.fn() }));

    act(() => result.current.begin());
    act(() => void vi.advanceTimersByTime(20_000));
    act(() => result.current.markActivity());
    act(() => void vi.advanceTimersByTime(11_000));

    // A busy conversation still ends at the cap; only the idle timer is affected by activity.
    expect(onMax).toHaveBeenCalledTimes(1);
  });

  it("cancel() stops both timers without firing", () => {
    const onMax = vi.fn();
    const onIdle = vi.fn();
    const { result } = renderHook(() => useSessionLimits({ maxDurationMs: 1000, idleTimeoutMs: 1000, idleWarningMs: 500, onMaxReached: onMax, onIdleEnd: onIdle }));

    act(() => result.current.begin());
    act(() => result.current.cancel());
    act(() => void vi.advanceTimersByTime(10_000));

    expect(onMax).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
    expect(result.current.remainingMs).toBeNull();
  });

  it("reset() restarts the clock, as a reconnect needs", () => {
    const onMax = vi.fn();
    const { result } = renderHook(() => useSessionLimits({ maxDurationMs: 60_000, idleTimeoutMs: 60_000, idleWarningMs: 45_000, onMaxReached: onMax, onIdleEnd: vi.fn() }));

    act(() => result.current.begin());
    act(() => void vi.advanceTimersByTime(50_000));
    act(() => result.current.reset());

    expect(result.current.remainingMs).toBe(60_000);
    act(() => void vi.advanceTimersByTime(50_000));
    expect(onMax).not.toHaveBeenCalled();
  });

  it("supports no cap at all", () => {
    const onMax = vi.fn();
    const { result } = renderHook(() => useSessionLimits({ maxDurationMs: null, idleTimeoutMs: 600_000, idleWarningMs: 45_000, onMaxReached: onMax, onIdleEnd: vi.fn() }));

    act(() => result.current.begin());
    act(() => void vi.advanceTimersByTime(600_000));

    expect(result.current.remainingMs).toBeNull();
    expect(onMax).not.toHaveBeenCalled();
  });

  it("stops ticking after unmount", () => {
    const onMax = vi.fn();
    const { result, unmount } = renderHook(() => useSessionLimits({ maxDurationMs: 1000, idleTimeoutMs: 1000, idleWarningMs: 500, onMaxReached: onMax, onIdleEnd: vi.fn() }));

    act(() => result.current.begin());
    unmount();
    act(() => void vi.advanceTimersByTime(5000));

    expect(onMax).not.toHaveBeenCalled();
  });
});

describe("countdown rendering", () => {
  it("shows a countdown region while a session is live", () => {
    // A live region is what lets a screen reader announce the remaining time without stealing focus.
    render(
      <p className="countdown" role="status" aria-live="polite">
        {formatCountdown(65_000)} left
      </p>,
    );
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("1:05 left");
    expect(region.getAttribute("aria-live")).toBe("polite");
  });
});