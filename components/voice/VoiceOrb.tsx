"use client";

import { useEffect, useRef } from "react";
import type { VoiceState } from "@/lib/voice/types";

/**
 * The voice ring.
 *
 * The subject of this interface is a live spoken conversation, and the ring is the only thing on
 * screen that is allowed to move on its own. It is a ring of short radial strokes rather than a
 * filled shape for one reason: length reads as amplitude, so the ring is a direct picture of what
 * the microphone is hearing or the assistant is producing, with no decoration in between.
 *
 * Motion is chosen per state and nothing animates on a timer for its own sake:
 *
 * - voice states  length follows the measured level, per stroke, so the shape is the signal
 * - thinking      a comet head sweeps the ring with a decaying tail
 * - listening     a faint breath, present but nearly still
 * - idle/error    still, with only the colour carrying the state
 *
 * Colour means the same thing here as everywhere else in the interface: ultramarine is you, amber
 * is the assistant, everything else is neutral so it cannot be mistaken for either.
 *
 * `aria-hidden` on purpose. The status line and turn indicator already say all of this in text, and
 * a canvas has nothing to offer a screen reader beyond a duplicate.
 */

/** How many strokes make up the ring. */
const STROKES = 112;

type Rgb = [number, number, number];

type Palette = {
  user: Rgb;
  assistant: Rgb;
  neutral: Rgb;
};

/**
 * Canvas cannot read CSS custom properties, so the palette is duplicated here as raw RGB and
 * selected with matchMedia. Nothing enforces that these stay equal to the tokens in globals.css —
 * a canvas that drifts from the page's colours is worse than no ring at all — so this is the one
 * place in the interface where a colour change has to be made twice. The neutral is a tone of its
 * own rather than a token, since nothing else on the page needs it.
 *
 * --user and --assistant are copied verbatim, so the ring, the turn indicator and the transcript
 * are guaranteed to be the same ultramarine and the same amber.
 */
const PALETTES: Record<"light" | "dark", Palette> = {
  light: {
    user: [0x35, 0x50, 0xe8],
    assistant: [0xd6, 0x86, 0x10],
    neutral: [0x7a, 0x83, 0x99],
  },
  dark: {
    user: [0x7c, 0x93, 0xff],
    assistant: [0xf5, 0xb6, 0x55],
    neutral: [0x74, 0x7e, 0xa4],
  },
};

/** Which colour and which level the ring should follow. */
type Mode = "user" | "assistant" | "comet" | "breath" | "still";

const MODES: Record<VoiceState, Mode> = {
  idle: "breath",
  connecting: "breath",
  reconnecting: "breath",
  listening: "breath",
  user_speaking: "user",
  speaking: "assistant",
  assistant_speaking: "assistant",
  // The user cutting in: that is user audio and user colour.
  interrupting: "user",
  interrupted: "still",
  thinking: "comet",
  error: "still",
};

export interface VoiceOrbProps {
  state: VoiceState;
  /** Reads the current microphone amplitude, 0–1. Called inside the animation frame. */
  micLevel: () => number;
  /** Reads the current assistant output amplitude, 0–1. Called inside the animation frame. */
  assistantLevel: () => number;
  size?: number;
  active: boolean;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(from: Rgb, to: Rgb, t: number): Rgb {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

export function VoiceOrb({ state, micLevel, assistantLevel, size = 220, active }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  const activeRef = useRef(active);
  // Readers rather than sampled values: amplitude changes ~60×/second, so sampling it during render
  // would either be stale or force a re-render on every frame.
  const micRef = useRef(micLevel);
  const assistantRef = useRef(assistantLevel);

  stateRef.current = state;
  activeRef.current = active;
  micRef.current = micLevel;
  assistantRef.current = assistantLevel;

  /**
   * Both media queries are read into refs rather than state. They can change at runtime and the
   * canvas needs the current value on every frame; state would tear down and rebuild the whole
   * effect on every toggle, restarting the animation from scratch.
   */
  const reducedMotionRef = useRef(false);
  const darkRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    reducedMotionRef.current = reduced.matches;
    darkRef.current = dark.matches;

    const onReduced = (event: MediaQueryListEvent) => {
      reducedMotionRef.current = event.matches;
    };
    const onDark = (event: MediaQueryListEvent) => {
      darkRef.current = event.matches;
    };
    reduced.addEventListener?.("change", onReduced);
    dark.addEventListener?.("change", onDark);
    return () => {
      reduced.removeEventListener?.("change", onReduced);
      dark.removeEventListener?.("change", onDark);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    // Draw at device resolution: a 2× ring drawn at CSS pixels is visibly soft on any modern
    // screen, and strokes are thin enough that the softness shows as fuzz.
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(size * ratio);
    canvas.height = Math.round(size * ratio);

    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - size * 0.13;
    const trackLength = size * 0.05;
    const maxLength = size * 0.15;
    const lineWidth = Math.max(1.5, size * 0.009);

    // The current colour eases toward its target rather than snapping, so the handover between
    // speakers reads as one ring changing colour instead of two things happening at once.
    let colour: Rgb = PALETTES.light.neutral;
    let startedAt = performance.now();

    const targetColour = (mode: Mode, palette: Palette): Rgb => {
      if (mode === "user") return palette.user;
      if (mode === "assistant") return palette.assistant;
      return palette.neutral;
    };

    const draw = (now: number) => {
      const palette = PALETTES[darkRef.current ? "dark" : "light"];
      const mode = MODES[stateRef.current];
      const elapsed = (now - startedAt) / 1000;
      const reduced = reducedMotionRef.current;

      // ~1 - e^(-t/0.12) over the frame, i.e. roughly 350ms to settle.
      colour = lerpRgb(colour, targetColour(mode, palette), reduced ? 1 : 0.12);

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.lineCap = "round";
      context.lineWidth = lineWidth * ratio;

      const level =
        mode === "user" ? micRef.current() : mode === "assistant" ? assistantRef.current() : 0;

      // Under reduced motion the ring is a single still frame at a fixed, legible length. No spin,
      // no comet, no wobble, and no dependence on live amplitude.
      const useLevel = !reduced && (mode === "user" || mode === "assistant");

      for (let i = 0; i < STROKES; i += 1) {
        const angle = (i / STROKES) * Math.PI * 2 - Math.PI / 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        let length = trackLength;
        let alpha = 0.42;

        if (useLevel) {
          // Per-stroke variation, scrolling slowly, so the ring has an organic outline instead of
          // reading as a single uniform spike.
          const variation = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(i * 0.73 + elapsed * 2.1));
          length = trackLength + level * maxLength * variation;
          alpha = 0.55 + 0.45 * level;
        } else if (mode === "comet" && !reduced) {
          // Head sweeps once per 1.6s; each stroke brightens as the head passes and decays behind
          // it, which is what makes it read as travelling rather than pulsing.
          const head = ((elapsed / 1.6) % 1) * STROKES;
          const behind = (head - i + STROKES) % STROKES;
          const proximity = 1 - behind / (STROKES * 0.42);
          if (proximity > 0) {
            const eased = proximity * proximity;
            length = trackLength + maxLength * 0.62 * eased;
            alpha = 0.4 + 0.6 * eased;
          }
        } else if (mode === "breath" && !reduced) {
          const breath = 0.5 + 0.5 * Math.sin(elapsed * 1.1);
          length = trackLength + maxLength * 0.16 * breath;
          alpha = 0.5 + 0.2 * breath;
        } else if (activeRef.current && !reduced && mode === "still") {
          // Interrupted and error states still breathe, very faintly, so a stopped ring does not
          // read as a crashed one.
          length = trackLength + maxLength * 0.05;
          alpha = 0.42;
        }

        const inner = radius - length / 2;
        context.globalAlpha = alpha;
        // Every stroke uses the eased colour, which resolves to ultramarine for you, amber for the
        // assistant, and neutral for everything else. An earlier version drew neutral states in the
        // faint track colour, which made "listening" look like a ring that had failed to load
        // rather than one that was deliberately calm.
        context.strokeStyle = `rgb(${colour[0] | 0}, ${colour[1] | 0}, ${colour[2] | 0})`;

        context.beginPath();
        context.moveTo((cx + cos * inner) * ratio, (cy + sin * inner) * ratio);
        context.lineTo((cx + cos * (inner + length)) * ratio, (cy + sin * (inner + length)) * ratio);
        context.stroke();
      }

      context.globalAlpha = 1;
    };

    if (reducedMotionRef.current) {
      // One frame, then stop. No requestAnimationFrame at all under reduced motion: a loop that
      // redraws an identical picture sixty times a second is pure cost.
      startedAt = performance.now();
      draw(startedAt);
      const onDarkChange = () => {
        startedAt = performance.now();
        draw(startedAt);
      };
      const dark = window.matchMedia?.("(prefers-color-scheme: dark)");
      dark?.addEventListener?.("change", onDarkChange);
      return () => dark?.removeEventListener?.("change", onDarkChange);
    }

    let frame = 0;
    const loop = (now: number) => {
      draw(now);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [size, state]);

  return (
    <canvas
      ref={canvasRef}
      className="ring-canvas"
      style={{ width: size, height: size }}
      role="presentation"
      aria-hidden="true"
    />
  );
}