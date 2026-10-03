/**
 * Runs once when the server starts, before any request is handled.
 *
 * Sentry is initialised here rather than in a route so a single place owns the lifecycle, and
 * `initSentry` is a no-op unless `SENTRY_DSN` is set. The Edge runtime is skipped because the
 * reporter is loaded through a variable specifier that only resolves in the Node build.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initSentry } = await import("@/lib/sentry");
    await initSentry();
  }
}
