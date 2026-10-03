"use client";

import { useEffect, useState } from "react";
import type { UsageLogEntry } from "@/lib/usage/log";

/**
 * Development-only panel showing what the current session is costing and how the server is
 * configured.
 *
 * Token counts are the point: a realtime session is metered per turn, and the SDK's
 * `run-completed` event is the only place that number appears. Seeing it live is the difference
 * between "the demo felt slow" and knowing which turn was expensive.
 *
 * The component renders `null` in a production build. That check lives here rather than at the
 * call site so a panel cannot be shipped by accident when someone adds it to a new layout.
 */

export type HealthReport = {
  status: string;
  uptimeSeconds: number;
  version: string;
  checks: { openai: boolean; tavily: boolean; auth: boolean; sentry: boolean };
};

/** Formats a token count compactly: 1234 becomes "1.2k". */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** One "label: value" line per configured integration, for the server section. */
export function summariseHealth(health: HealthReport | null, error: string | null): string[] {
  if (error) return [`health check failed: ${error}`];
  if (!health) return ["checking server…"];
  const rows: string[] = [`status: ${health.status}`, `uptime: ${formatDuration(health.uptimeSeconds * 1000)}`];
  for (const [name, on] of Object.entries(health.checks)) {
    rows.push(`${name}: ${on ? "on" : "off"}`);
  }
  return rows;
}

export interface UsagePanelProps {
  usage: UsageLogEntry | null;
}

export function UsagePanel({ usage }: UsagePanelProps) {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    let cancelled = false;
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((body: HealthReport) => {
        if (!cancelled) setHealth(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setHealthError(err instanceof Error ? err.message : "unknown error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (process.env.NODE_ENV === "production") return null;

  return (
    <details className="usage-panel">
      <summary className="usage-panel-summary">Session usage (dev only)</summary>

      <dl className="usage-panel-grid">
        <dt>turns</dt>
        <dd>{usage?.turns ?? 0}</dd>
        <dt>input tokens</dt>
        <dd>{formatTokens(usage?.inputTokens ?? 0)}</dd>
        <dt>output tokens</dt>
        <dd>{formatTokens(usage?.outputTokens ?? 0)}</dd>
        <dt>total tokens</dt>
        <dd>{formatTokens(usage?.totalTokens ?? 0)}</dd>
        <dt>elapsed</dt>
        <dd>{formatDuration(usage?.durationMs ?? 0)}</dd>
        <dt>reconnects</dt>
        <dd>{usage?.reconnects ?? 0}</dd>
        <dt>errors</dt>
        <dd>{usage?.errors ?? 0}</dd>
        <dt>tools</dt>
        <dd>{usage?.toolsInvoked ?? 0}</dd>
        <dt>events</dt>
        <dd>{usage?.events ?? 0}</dd>
        <dt>session</dt>
        <dd>{usage?.sessionId ?? "—"}</dd>
      </dl>

      <h3 className="usage-panel-heading">Server</h3>
      <ul className="usage-panel-list">
        {summariseHealth(health, healthError).map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
    </details>
  );
}
