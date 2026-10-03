import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
        // Whether the documentation index is present. A missing `content/index.json` is the one
        // failure mode that shows up as a mysteriously unhelpful assistant rather than an error,
        // so it is worth a line here.
        docs: existsSync(join(process.cwd(), "content", "index.json")),
      },
    },
    { status: 200 },
  );
}
