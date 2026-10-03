"use server";

import { signOut } from "@/lib/auth";

/**
 * Sign-out, as a server action.
 *
 * It lives in its own module rather than inline in the component because the component is part of
 * the client tree, and Next only permits inline `"use server"` functions in server components.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
