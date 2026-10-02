"use client";

import { useEffect, useRef } from "react";
import type { VoiceState } from "@/lib/voice/types";

/**
 * The voice orb.
 *
 * Rendered on a canvas and driven by the conversation state plus real measured amplitude, so it
 * reflects what is actually happening rather than animating on a timer. Each state has a distinct
 * colour and motion character; amplitude adds a reactive ripple that grows with loudness.
 */

interface OrbTheme {
  /** Base colour, `r g b`. */
  rgb: [number, number, number];
  /** Ripple colour, `r g b`. */
  accent: [number, number, number];
  /** Idle breathing amplitude, 0–1. */
  breath: number;
  label: string;
}

const THEMES: Record<VoiceState, OrbTheme> = {
  idle: { rgb: [96, 106, 130], accent: [130, 142, 170], breath: 0.06, label: "Ready" },
  connecting: { rgb: [120, 108, 150], accent: [160, 146, 196], breath: 0.1, label: "Connecting" },
  reconnecting: { rgb: [150, 118, 92], accent: [196, 160, 124], breath: 0.12, label: "Reconnecting" },
  listening: { rgb: [82, 124, 168], accent: [126, 172, 220], breath: 0.09, label: "Listening" },
  user_speaking: { rgb: [64, 148, 152], accent: [110, 202, 202], breath: 0.14, label: "You're speaking" },
  thinking: { rgb: [126, 116, 172], accent: [172, 162, 224], breath: 0.16, label: "Thinking" },
  speaking: { rgb: [64, 148, 152], accent: [110, 202, 202], breath: 0.14, label: "Speaking" },
  assistant_speaking: { rgb: [64, 148, 152], accent: [110, 202, 202], breath: 0.14, label: "Speaking" },
  interrupting: { rgb: [176, 128, 82], accent: [224, 172, 118], breath: 0.2, label: "Interrupting" },
  interrupted: { rgb: [176, 128, 82], accent: [224, 172, 118], breath: 0.2, label: "Interrupted" },
  error: { rgb: [172, 96, 96], accent: [224, 132, 132], breath: 0.08, label: "Error" },
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

export function VoiceOrb({ state, micLevel, assistantLevel, size = 220, active }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  // Readers rather than sampled values: amplitude changes ~60×/second, so sampling it during
  // render would either be stale or force a re-render on every frame.
  const micRef = useRef(micLevel);
  const assistantRef = useRef(assistantLevel);
  const activeRef = useRef(active);

  stateRef.current = state;
  micRef.current = micLevel;
  assistantRef.current = assistantLevel;
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    let frame = 0;
    let time = 0;
    // Smoothly interpolated values, so state changes ease rather than snap.
    let displayLevel = 0;
    let targetPulse = 0;
    let lastKey = stateRef.current;

    const render = () => {
      time += 0.016;
      const current = THEMES[stateRef.current] ?? THEMES.idle;
      const nextKey = stateRef.current;
      if (nextKey !== lastKey) {
        // Brief brightening when the state changes, to make the transition legible.
        targetPulse = 1;
        lastKey = nextKey;
      }
      targetPulse *= 0.92;

      // Whose turn is it? Only the active speaker contributes amplitude.
      const isUser = stateRef.current === "user_speaking";
      const isAssistant = stateRef.current === "assistant_speaking";
      const rawLevel = isUser ? micRef.current() : isAssistant ? assistantRef.current() : 0;
      // Slight smoothing on the way in, decay on the way out.
      displayLevel = rawLevel > displayLevel ? displayLevel + (rawLevel - displayLevel) * 0.5 : displayLevel * 0.9 + rawLevel * 0.1;

      const cx = size / 2;
      const cy = size / 2;
      const baseRadius = size * 0.28;
      const breath = Math.sin(time * 1.4) * 0.5 + 0.5; // 0–1
      const pulseBoost = targetPulse * size * 0.05;
      const radius = baseRadius * (1 + current.breath * breath + displayLevel * 0.28) + pulseBoost;

      ctx.clearRect(0, 0, size, size);

      const [r, g, b] = current.rgb;
      const [ar, ag, ab] = current.accent;

      // Outer reactive halo.
      const haloRadius = radius * (1.35 + displayLevel * 0.5);
      const halo = ctx.createRadialGradient(cx, cy, radius * 0.7, cx, cy, haloRadius);
      halo.addColorStop(0, `rgba(${ar}, ${ag}, ${ab}, ${0.16 + displayLevel * 0.2})`);
      halo.addColorStop(1, `rgba(${ar}, ${ag}, ${ab}, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, haloRadius, 0, Math.PI * 2);
      ctx.fill();

      // Core body.
      const body = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.35, radius * 0.1, cx, cy, radius);
      body.addColorStop(0, `rgba(${Math.min(255, ar + 20)}, ${Math.min(255, ag + 20)}, ${Math.min(255, ab + 20)}, 0.95)`);
      body.addColorStop(0.65, `rgba(${r}, ${g}, ${b}, 0.9)`);
      body.addColorStop(1, `rgba(${Math.round(r * 0.6)}, ${Math.round(g * 0.6)}, ${Math.round(b * 0.7)}, 0.75)`);
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      // Reactive ripples radiating from the core when there's real audio energy.
      if (activeRef.current && displayLevel > 0.02) {
        const rings = 3;
        for (let i = 0; i < rings; i++) {
          const phase = (time * 0.9 + i / rings) % 1;
          const ringRadius = radius + phase * size * 0.28 * (0.4 + displayLevel);
          const alpha = (1 - phase) * 0.3 * displayLevel;
          ctx.strokeStyle = `rgba(${ar}, ${ag}, ${ab}, ${alpha.toFixed(3)})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Thin outer stroke for definition.
      ctx.strokeStyle = `rgba(${ar}, ${ag}, ${ab}, 0.45)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [size]);

  const theme = THEMES[state] ?? THEMES.idle;
  const isTurn = state === "user_speaking" || state === "assistant_speaking";

  return (
    <div className="orb-wrap" style={{ width: size, height: size }}>
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        role="img"
        aria-label={`Voice assistant status: ${theme.label}`}
      />
      {isTurn && (
        <span className="orb-badge" aria-hidden="true">
          {state === "user_speaking" ? "You" : "SamAI"}
        </span>
      )}
    </div>
  );
}