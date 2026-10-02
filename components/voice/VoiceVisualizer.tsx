"use client";

import { useEffect, useRef } from "react";

/**
 * Compact amplitude bars.
 *
 * Like the orb, this is driven by measured levels sampled inside the animation frame rather than
 * by props changing on every render.
 */

export interface VoiceVisualizerProps {
  /** Returns the current level, 0–1. */
  level: () => number;
  bars?: number;
  color?: string;
  active: boolean;
  height?: number;
}

export function VoiceVisualizer({ level, bars = 24, color = "rgba(126, 172, 220, 0.9)", active, height = 40 }: VoiceVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(level);
  const activeRef = useRef(active);
  levelRef.current = level;
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = bars * 5;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Persisted per-bar values give a rolling history rather than a uniform pulse.
    const values = new Array<number>(bars).fill(0);
    let frame = 0;

    const render = () => {
      const current = activeRef.current ? levelRef.current() : 0;
      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < bars; i++) {
        const target = current;
        values[i] = values[i] * 0.82 + target * 0.18;
        // Centre-weighted so the middle bars respond most, which reads as more natural.
        const centreWeight = 1 - Math.abs(i - (bars - 1) / 2) / (bars / 2);
        const barHeight = Math.max(2, values[i] * height * (0.45 + centreWeight * 0.55));
        const x = i * 5 + 1;
        const y = (height - barHeight) / 2;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.35 + values[i] * 0.65;
        ctx.beginPath();
        ctx.roundRect(x, y, 3, barHeight, 1.5);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [bars, color, height]);

  return <canvas ref={canvasRef} style={{ width: bars * 5, height }} aria-hidden="true" />;
}