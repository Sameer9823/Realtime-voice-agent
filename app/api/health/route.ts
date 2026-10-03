import { NextResponse } from "next/server";

/**
 * Liveness and configuration probe.
 *
 * Deploy platforms use this to decide whether to route traffic here, so it must stay cheap
 * and must never depend on an outbound call. It deliberately reports only *whether* a
 * secret is present, never its value: a health endpoint that leaks configuration is a
 * reconnaissance endpoint.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startedAtMs = Date.now();

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
      version: process.env.npm_package_version ?? "0.0.0",
      checks: {
        openai: Boolean(process.env.OPENAI_API_KEY),
        tavily: Boolean(process.env.TAVILY_API_KEY),
        auth: process.env.REQUIRE_AUTH === "true",
        sentry: Boolean(process.env.SENTRY_DSN),
      },
    },
    { status: 200 },
  );
}
