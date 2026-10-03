/**
 * Authentication settings that need no `next-auth` import.
 *
 * Middleware runs on the Edge runtime, and importing the full NextAuth stack there pulls the JWE
 * crypto chain (`jose`) into the Edge bundle — roughly 88 kB, plus a build warning about Node APIs
 * that the bundle never actually calls. The middleware only needs to know whether a session cookie
 * is present, so it reads its configuration from here.
 *
 * The cookie name is declared once, in `lib/auth.ts`, and imported from here, so the two cannot
 * drift apart.
 */

/** Session cookie name. Shared with `authConfig.cookies` so both sides agree. */
export const SESSION_COOKIE = "voice-agent.session";

/**
 * True when the deployment has opted into authentication.
 *
 * The middleware trusts this, and so does every route handler. It is read per request rather than
 * captured at module load, so toggling the variable does not need a rebuild to take effect in
 * development.
 */
export function authRequired(env: Record<string, string | undefined> = process.env): boolean {
  return env.REQUIRE_AUTH === "true";
}
