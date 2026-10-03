import { signOutAction } from "@/lib/auth-actions";

/**
 * Sign-out control, rendered only when the deployment requires authentication.
 *
 * The action is imported from a `"use server"` module rather than declared inline, because this
 * component is part of the client tree. That keeps the page free of any `SessionProvider` — the
 * app holds no client-side session state.
 */
export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <button type="submit" className="button button-quiet">
        Sign out
      </button>
    </form>
  );
}
