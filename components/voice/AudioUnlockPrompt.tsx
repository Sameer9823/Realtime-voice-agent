"use client";

import { useEffect } from "react";

/**
 * The iOS Safari autoplay gate.
 *
 * Browsers will not play audio until the page has been interacted with, and Safari does not
 * reveal its "unlock" state until playback is actually attempted — so the first attempt fails and
 * this prompt appears. Any interaction (tap, click, keypress) clears it.
 *
 * Shown only when the platform plausibly needs it. On desktop browsers the `play()` rejection is
 * rare, and showing a prompt that turns out to be unnecessary is worse than a failed autoplay.
 */

export interface AudioUnlockPromptProps {
  /** False once the user has interacted, or where autoplay is not gated. */
  visible: boolean;
  onUnlock(): void;
}

function needsUnlockPrompt(): boolean {
  if (typeof navigator === "undefined") return false;
  // iOS in any form, including iPadOS which reports as Mac with touch support.
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const iPadOS = navigator.platform === "MacIntel" && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
  return iOS || iPadOS;
}

export function AudioUnlockPrompt({ visible, onUnlock }: AudioUnlockPromptProps) {
  useEffect(() => {
    if (!visible) return;

    const unlock = () => onUnlock();
    // `once` on all three: this is a one-way transition, and leaving listeners attached would keep
    // the handler alive for the life of the page.
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    window.addEventListener("touchstart", unlock, { once: true });

    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
  }, [visible, onUnlock]);

  if (!visible || !needsUnlockPrompt()) return null;

  return (
    <button type="button" className="unlock-prompt" onClick={onUnlock} aria-label="Tap to enable audio">
      <span className="unlock-title">Tap to enable audio</span>
      <span className="unlock-hint">Your browser needs one tap before it will play sound.</span>
    </button>
  );
}