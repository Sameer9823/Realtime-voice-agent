import { redactObject } from "@/lib/usage/redact";

/**
 * Optional error reporting.
 *
 * `@sentry/nextjs` is not a dependency of this app — a demo voice agent should not force a
 * telemetry vendor on anyone who clones it. So Sentry is loaded through a variable
 * specifier (kept out of the bundler's static analysis) and only when `SENTRY_DSN` is set.
 * With no DSN, and also when the package is simply not installed, every export here is a
 * no-op that returns `false`. Nothing in the app should need to check whether reporting is
 * on before calling it.
 */

export type ErrorContext = Record<string, unknown>;

export type SentryClient = {
  captureException: (error: unknown, context?: ErrorContext) => void;
  captureMessage: (message: string, context?: ErrorContext) => void;
};

let client: SentryClient | null = null;
let attempted = false;

type Loader = (specifier: string) => Promise<SentryClient>;

const defaultLoader: Loader = async (specifier) => {
  const mod = (await import(/* webpackIgnore: true */ specifier)) as SentryClient;
  return mod;
};

/** Initialises reporting if a DSN is configured. Safe to call more than once. */
export async function initSentry(loader: Loader = defaultLoader): Promise<boolean> {
  if (attempted) return client !== null;
  attempted = true;
  if (!process.env.SENTRY_DSN) return false;

  try {
    client = await loader(/* webpackIgnore: true */ "@sentry/nextjs");
    return true;
  } catch (err) {
    console.warn("[sentry] not initialised:", err instanceof Error ? err.message : err);
    client = null;
    return false;
  }
}

export function sentryEnabled(): boolean {
  return client !== null;
}

/**
 * Forwards an exception. The context is redacted here rather than in the loader so redaction
 * cannot be bypassed by whichever client is installed.
 */
export function captureException(error: unknown, context: ErrorContext = {}): void {
  client?.captureException(error, redactObject(context));
}

export function captureMessage(message: string, context: ErrorContext = {}): void {
  client?.captureMessage(message, redactObject(context));
}

/** Test seam: drops the memoised client so the next `initSentry` call retries. */
export function resetSentryForTests(): void {
  client = null;
  attempted = false;
}
