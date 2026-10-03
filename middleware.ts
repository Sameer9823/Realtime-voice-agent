import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authRequired } from "@/lib/auth-env";

/**
 * Route protection, active only when `REQUIRE_AUTH=true`.
 *
 * This checks for the *presence* of a session cookie and nothing more. That is enough to send a
 * signed-out visitor to the login page, and it is not the security boundary: every route handler
 * verifies the session itself with the real crypto, and a stale or forged cookie simply gets a 401
 * from the API. The split exists because verifying a JWE on the Edge runtime drags the whole Auth
 * crypto chain into the middleware bundle for a check the handlers make anyway.
 *
 * So: this file protects the user experience, and `checkAuth()` in `lib/auth.ts` protects the app.
 */

const PUBLIC_PATHS = ["/login", "/api/auth", "/api/health"];

export function middleware(request: NextRequest) {
  if (!authRequired()) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", message: "Sign in to use this voice agent." },
      { status: 401 },
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  // Only same-origin paths are echoed back, so the login page cannot be used as an open redirect.
  url.searchParams.set("from", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico|webmanifest)$).*)"],
};
