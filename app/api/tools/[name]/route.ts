import { NextResponse } from "next/server";
import { buildGuard, checkLimits, checkOrigin } from "@/lib/voice/guard";
import { checkAuth, guardKey } from "@/lib/auth";
import { findTool } from "@/lib/tools/registry";
import { captureException } from "@/lib/sentry";

/**
 * Server-side tool execution.
 *
 * Tools that call a search API, a weather API, or read the filesystem run here rather than
 * in the browser, so `TAVILY_API_KEY` never reaches client code and nobody can point the
 * endpoint at an arbitrary URL. The same guard the session route uses applies here: an open
 * tool route is an open proxy to whatever the tool calls.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Built once per process: the limiters hold the rate-limit buckets, so per-request construction
 * would reset the counters and make the limit useless. */
let guardPromise: ReturnType<typeof buildGuard> | null = null;
function sharedGuard() {
  guardPromise ??= buildGuard();
  return guardPromise;
}

/** Cap on the body a client may send, so the route cannot be used to push large payloads. */
const MAX_BODY_CHARS = 2000;

interface ToolRouteContext {
  params: Promise<{ name: string }>;
}

export async function POST(request: Request, context: ToolRouteContext) {
  const guard = await sharedGuard();

  const origin = checkOrigin(request.headers.get("origin"), guard.allowedOrigins);
  if (!origin.ok) return refusal(origin.status, origin.message ?? "Origin not allowed.");

  const authorized = await checkAuth();
  if (!authorized.ok) return refusal(authorized.status, authorized.message ?? "Sign in to use this voice agent.");

  const limits = await checkLimits(await guardKey(request), guard);
  if (!limits.ok) return refusal(limits.status, limits.message ?? "Too many requests.");

  const { name } = await context.params;

  const tool = findTool(name);
  if (!tool) {
    return refusal(404, `No tool named "${name}".`);
  }

  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) {
      return refusal(413, "Those arguments are too large.");
    }
    if (text) raw = JSON.parse(text);
  } catch {
    return refusal(400, "Could not read the tool arguments.");
  }

  // The model can send anything; the schema is the only thing standing between a malformed
  // call and an exception inside a tool. Reject here so failures stay speakable.
  const parsed = tool.parameters.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join(".") || "arguments";
    return refusal(400, `The ${field} argument is missing or invalid.`);
  }

  try {
    const result = await tool.execute(parsed.data);
    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (err) {
    // Tools are contracted to return friendly strings, so reaching here is a bug. Log the
    // detail server-side and speak something safe rather than leaking a stack trace.
    console.error(`[tools/${name}] threw:`, err);
    captureException(err, { tool: name });
    return refusal(500, `The ${tool.name.replace(/_/g, " ")} tool failed. Please try again.`);
  }
}

function refusal(status: number, message: string) {
  return NextResponse.json({ ok: false, error: message }, { status });
}