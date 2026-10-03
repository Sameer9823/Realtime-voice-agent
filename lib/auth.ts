import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { clientKey, type GuardDecision } from "@/lib/voice/guard";
import { SESSION_COOKIE } from "@/lib/auth-env";

export { authRequired, SESSION_COOKIE } from "@/lib/auth-env";
import { authRequired } from "@/lib/auth-env";

/**
 * Optional authentication, off unless `REQUIRE_AUTH=true`.
 *
 * A voice agent is expensive per minute, so anyone who puts one on the public internet will want a
 * login in front of it. That is opt-in here: the app runs fully open with no configuration at all,
 * which is what makes it a demo you can clone and press Start on.
 *
 * Two providers, because a real deployment and a local trial need different things:
 *
 * - GitHub, active once `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` are set. No password storage, and
 *   a real identity provider, so this is the one to use in production.
 * - Credentials, a single shared email and password from `AUTH_EMAIL` / `AUTH_PASSWORD`. It exists so
 *   the gate can be tested without registering an OAuth app. It is a shared secret, not a user
 *   store, and the provider is left out entirely when those variables are unset — an unset password
 *   must never fall open.
 */

const providers: NextAuthConfig["providers"] = [];
/** Tracked alongside `providers` because the `Provider` type does not expose its own id. */
const providerIds: string[] = [];

if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
    }),
  );
  providerIds.push("github");
}

if (process.env.AUTH_EMAIL && process.env.AUTH_PASSWORD) {
  providers.push(
    Credentials({
      id: "credentials",
      name: "Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize(credentials) {
        const email = typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!email || !password) return null;
        if (!constantTimeEquals(email, process.env.AUTH_EMAIL!.trim().toLowerCase())) return null;
        if (!constantTimeEquals(password, process.env.AUTH_PASSWORD!)) return null;
        return { id: email, email, name: email };
      },
    }),
  );
  providerIds.push("credentials");
}

export const authConfigured = providers.length > 0;

/** Ids of the providers that are actually active, so the sign-in page can offer exactly those. */
export const activeProviderIds = providerIds;

/**
 * Compares two strings without leaking their contents through timing.
 *
 * The length check is unavoidable — a comparison that short-circuits on length is already
 * measurably faster — but comparing only the shared prefix stops an attacker learning the
 * configured secret one character at a time.
 */
export function constantTimeEquals(a: string, b: string | undefined): boolean {
  // `undefined` only. Testing `!b` would also reject an empty expected value, which is a different
  // thing entirely.
  if (b === undefined) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const authConfig: NextAuthConfig = {
  providers,
  pages: { signIn: "/login" },
  // JWT rather than a database session: there is no database in this app, and a stateless session
  // keeps every route handler free of a store lookup.
  session: { strategy: "jwt" },
  // The name is pinned rather than left to the Auth.js default so the Edge middleware can look for
  // the same cookie without importing this module. See `lib/auth-env.ts` for why that matters.
  cookies: {
    sessionToken: {
      name: SESSION_COOKIE,
      options: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  },
  // Required when the app is served from a host other than the provider's own domain, which is
  // every self-hosted deployment.
  trustHost: true,
  callbacks: {
    // Return the minimal identity the app needs. The default JWT payload can carry more than a
    // router should ever hold.
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

/**
 * The current identity, or null.
 *
 * Never throws when auth is switched off, so callers do not need to branch first. Reading a session
 * requires decrypting a cookie, which is why this is a server-side helper only.
 */
export async function currentIdentity(): Promise<AuthIdentity | null> {
  if (!authRequired()) return null;
  try {
    const session = await auth();
    if (!session?.user?.id) return null;
    return { userId: session.user.id };
  } catch {
    // A malformed or expired cookie is an anonymous request, not a server error.
    return null;
  }
}

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email?: string | null;
      name?: string | null;
      image?: string | null;
    };
  }
}

/** The identity the app actually uses. Deliberately not NextAuth's `Session`, so the decision table
 * below can be tested without a Next request context. */
export type AuthIdentity = { userId: string };

/**
 * The auth decision table, separated from reading the session so it can be tested directly.
 *
 * When auth is required but no provider is configured, this fails closed with a server error rather
 * than waving the request through. A deployment that asked for a login and silently served everyone
 * is the worst possible outcome, and an unusable app is a much easier problem to notice.
 */
export function decideAuth(identity: AuthIdentity | null, configured: boolean): GuardDecision {
  if (identity) return { ok: true, status: 200 };
  if (!configured) {
    console.error(
      "[auth] REQUIRE_AUTH=true but no provider is configured. Set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET, " +
        "or AUTH_EMAIL and AUTH_PASSWORD. Refusing every protected request until one is present.",
    );
    return {
      ok: false,
      status: 500,
      code: "forbidden",
      message: "Sign-in is misconfigured on the server. An administrator needs to set this up.",
    };
  }
  return { ok: false, status: 401, code: "unauthorized", message: "Sign in to use this voice agent." };
}

/** Enforces the session requirement for a public route. */
export async function checkAuth(): Promise<GuardDecision> {
  if (!authRequired()) return { ok: true, status: 200 };
  return decideAuth(await currentIdentity(), authConfigured);
}

/**
 * The key a rate-limit bucket is filed under.
 *
 * Prefers the signed-in user over the IP address. Behind one NAT or corporate proxy every visitor
 * otherwise shares a single bucket, so one busy user throttles everyone else; and a determined
 * caller rotating IPs would otherwise get a fresh allowance per address.
 */
export async function guardKey(request: Request): Promise<string> {
  const identity = await currentIdentity();
  if (identity) return `user:${identity.userId}`;
  return `ip:${clientKey(request)}`;
}
