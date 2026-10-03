import { handlers } from "@/lib/auth";

/**
 * NextAuth's own endpoints: sign-in callbacks, session, CSRF, and sign-out.
 *
 * This route always exists, even when `REQUIRE_AUTH` is false. Leaving it mounted means switching
 * auth on does not require a redeploy, and it gives nothing away while it is off — no provider is
 * configured without its credentials.
 */
export const { GET, POST } = handlers;
