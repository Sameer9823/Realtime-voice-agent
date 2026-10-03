import Link from "next/link";
import { authConfigured, authRequired, activeProviderIds, signIn } from "@/lib/auth";

/**
 * Sign-in page.
 *
 * A server component using NextAuth's server actions rather than the client `SessionProvider`: the
 * page only needs to post a form, and a provider-less tree is one less thing to break when auth is
 * switched off.
 *
 * It never reveals whether a specific account exists — a single message covers every failure,
 * because an "unknown email" reply is an account-enumeration oracle.
 */

const ERROR_TEXT: Record<string, string> = {
  CredentialsSignin: "That email and password did not match.",
  OAuthSignin: "Sign-in could not be completed. Please try again.",
  AccessDenied: "This account is not allowed to sign in.",
  Configuration: "Sign-in is misconfigured on the server.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; from?: string }>;
}) {
  const params = await searchParams;
  const from = params.from?.startsWith("/") ? params.from : "/";
  const error = params.error ? (ERROR_TEXT[params.error] ?? "Sign-in failed. Please try again.") : null;

  if (!authRequired()) {
    return (
      <main className="shell">
        <div className="panel">
          <h1 className="brand">Realtime Voice Agent</h1>
          <p className="status-hint">
            Sign-in is switched off. <Link href="/">Start a conversation</Link>.
          </p>
        </div>
      </main>
    );
  }

  if (!authConfigured) {
    return (
      <main className="shell">
        <div className="panel">
          <h1 className="brand">Realtime Voice Agent</h1>
          <div className="status status-error" role="alert">
            <p className="status-message">Sign-in is required but no provider is configured.</p>
            <p className="status-hint">
              Set <code>AUTH_GITHUB_ID</code> and <code>AUTH_GITHUB_SECRET</code>, or{" "}
              <code>AUTH_EMAIL</code> and <code>AUTH_PASSWORD</code>.
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="panel login">
        <h1 className="brand">Realtime Voice Agent</h1>
        <p className="status-hint">Sign in to start a conversation.</p>

        {error && (
          <div className="status status-error" role="alert">
            <p className="status-message">{error}</p>
          </div>
        )}

        {activeProviderIds.includes("github") && (
          <form action={githubSignIn}>
            <input type="hidden" name="from" value={from} />
            <button type="submit" className="button">
              Continue with GitHub
            </button>
          </form>
        )}

        {activeProviderIds.includes("credentials") && (
          <form action={passwordSignIn} className="login-form">
            <input type="hidden" name="from" value={from} />
            <label className="login-field">
              <span>Email</span>
              <input name="email" type="email" autoComplete="username" required />
            </label>
            <label className="login-field">
              <span>Password</span>
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button type="submit" className="button">
              Sign in
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

async function passwordSignIn(formData: FormData) {
  "use server";
  const from = String(formData.get("from") ?? "/");
  await signIn("credentials", {
    email: formData.get("email"),
    password: formData.get("password"),
    redirectTo: from,
  });
}

async function githubSignIn(formData: FormData) {
  "use server";
  const from = String(formData.get("from") ?? "/");
  await signIn("github", { redirectTo: from });
}

/** Keeps the sign-in page uncached: a redirect target can carry a one-time value. */
export const dynamic = "force-dynamic";
