"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Session lifetime limits.
 *
 * A realtime session bills per second and holds an open connection, so an abandoned tab would
 * otherwise keep costing money indefinitely. Two independent guards:
 *
 *  - a hard maximum session length, so no single conversation can run forever;
 *  - an idle timeout, so a session the user has walked away from ends promptly.
 *
 * The idle timer resets on any conversation activity. It warns before it fires, because ending a
 * conversation the user still considers active is worse than the cost of warning them.
 */

export interface SessionLimitsOptions {
  /** Hard cap in milliseconds. `null` disables it. */
  maxDurationMs: number | null;
  /** Silence after which the session ends. */
  idleTimeoutMs: number;
  /** How long before the idle cut-off the warning appears. */
  idleWarningMs: number;
  onMaxReached(): void;
  onIdleEnd(): void;
}

export interface SessionLimitsResult {
  /** Milliseconds left in the session, or null when there is no cap. */
  remainingMs: number | null;
  /** Milliseconds of silence so far. */
  idleMs: number;
  /** True once silence has passed the warning threshold but not the cut-off. */
  idleWarning: boolean;
  /** Call when the user, assistant, or any conversation event makes the session non-idle. */
  markActivity(): void;
  /** Begins counting. Safe to call repeatedly; restarts the clock. */
  begin(): void;
  /**
   * Halts both clocks without firing, used while the connection is down.
   *
   * A reconnecting session is not an idle one: the user is still there and the network is
   * flapping. Counting that time as silence would end the conversation before the backoff loop
   * got a chance to recover it.
   */
  pause(): void;
  /** Resumes after a pause, treating the moment as fresh activity. */
  resume(): void;
  /** Stops counting without firing either callback. */
  cancel(): void;
  /** Resets both clocks, used when a reconnect mints a new session. */
  reset(): void;
}

const TICK_MS = 500;

export function useSessionLimits(options: SessionLimitsOptions): SessionLimitsResult {
  const { maxDurationMs, idleTimeoutMs, idleWarningMs, onMaxReached, onIdleEnd } = options;

  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [idleMs, setIdleMs] = useState(0);
  const [idleWarning, setIdleWarning] = useState(false);

  const startedAtRef = useRef<number | null>(null);
  const lastActivityRef = useRef<number | null>(null);
  const firedRef = useRef({ max: false, idle: false });
  /** While paused the clocks are frozen rather than advanced. */
  const pausedRef = useRef(false);

  // Callbacks are read through a ref so a caller passing an inline arrow does not restart the
  // interval on every render.
  const onMaxRef = useRef(onMaxReached);
  const onIdleRef = useRef(onIdleEnd);
  onMaxRef.current = onMaxReached;
  onIdleRef.current = onIdleEnd;

  const begin = useCallback(() => {
    const now = Date.now();
    startedAtRef.current = now;
    lastActivityRef.current = now;
    firedRef.current = { max: false, idle: false };
    pausedRef.current = false;
    setRemainingMs(maxDurationMs);
    setIdleMs(0);
    setIdleWarning(false);
  }, [maxDurationMs]);

  const cancel = useCallback(() => {
    startedAtRef.current = null;
    lastActivityRef.current = null;
    pausedRef.current = false;
    setRemainingMs(null);
    setIdleMs(0);
    setIdleWarning(false);
  }, []);

  const pause = useCallback(() => {
    if (startedAtRef.current === null) return;
    pausedRef.current = true;
  }, []);

  const resume = useCallback(() => {
    if (startedAtRef.current === null) return;
    pausedRef.current = false;
    // Reconnecting counts as activity, so the user is not warned about silence they did not
    // cause, and the cap restarts from here rather than from before the drop.
    lastActivityRef.current = Date.now();
    setIdleMs(0);
    setIdleWarning(false);
  }, []);

  const reset = useCallback(() => {
    begin();
  }, [begin]);

  const markActivity = useCallback(() => {
    if (startedAtRef.current === null) return;
    lastActivityRef.current = Date.now();
    setIdleMs(0);
    setIdleWarning(false);
  }, []);

  useEffect(() => {
    const tick = () => {
      if (startedAtRef.current === null || pausedRef.current) return;
      const now = Date.now();

      if (maxDurationMs) {
        const left = Math.max(0, maxDurationMs - (now - startedAtRef.current));
        setRemainingMs(left);
        // Fired once: the callback ends the session, and re-firing would call it repeatedly.
        if (left <= 0 && !firedRef.current.max) {
          firedRef.current.max = true;
          onMaxRef.current();
        }
      }

      if (lastActivityRef.current !== null) {
        const idle = now - lastActivityRef.current;
        setIdleMs(idle);
        if (idle >= idleTimeoutMs && !firedRef.current.idle) {
          firedRef.current.idle = true;
          onIdleRef.current();
        } else {
          setIdleWarning(idle >= idleWarningMs);
        }
      }
    };

    const interval = setInterval(tick, TICK_MS);
    return () => clearInterval(interval);
  }, [maxDurationMs, idleTimeoutMs, idleWarningMs]);

  return { remainingMs, idleMs, idleWarning, markActivity, begin, pause, resume, cancel, reset };
}

/** Formats a duration as `m:ss`, used by the countdown. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}