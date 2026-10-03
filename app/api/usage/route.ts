import { NextResponse } from "next/server";
import { z } from "zod";
import { checkLimits, checkOrigin, clientKey, guardFromEnv } from "@/lib/voice/guard";
import { redactObject } from "@/lib/usage/redact";

/**
 * Session usage reporting.
 *
 * The browser already knows the token counts — they arrive on the agent's `run-completed`
 * event — so this endpoint's job is to give the server a place to put them, and to make
 * that shape strict. Anything accepted here is assumed to be attacker-controlled: the
 * schema bounds every field, the same origin/limiter guard the other routes use applies,
 * and the stored record is redacted before it is logged.
 *
 * There is no database. The record is written to the server log, which is what a
 * single-instance deployment can support honestly; the response deliberately does not echo
 * the stored record back so the endpoint cannot be used to probe for what was logged.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const guard = guardFromEnv();

const MAX_BODY_CHARS = 2000;

const usageSchema = z.object({
  sessionId: z.string().min(1).max(64),
  turns: z.number().int().min(0).max(10_000),
  inputTokens: z.number().int().min(0).max(10_000_000),
  outputTokens: z.number().int().min(0).max(10_000_000),
  totalTokens: z.number().int().min(0).max(20_000_000),
  reconnects: z.number().int().min(0).max(10_000),
  errors: z.number().int().min(0).max(10_000),
  toolsInvoked: z.number().int().min(0).max(10_000),
  durationMs: z.number().int().min(0).max(86_400_000),
  transports: z.array(z.string().max(32)).max(8),
  voice: z.string().max(32).optional(),
  model: z.string().max(64).optional(),
  persona: z.string().max(32).optional(),
  language: z.string().max(16).optional(),
});

export async function POST(request: Request) {
  const origin = checkOrigin(request.headers.get("origin"), guard.allowedOrigins);
  if (!origin.ok) return refusal(origin.status, origin.message ?? "Origin not allowed.");

  const limits = await checkLimits(clientKey(request), guard);
  if (!limits.ok) return refusal(limits.status, limits.message ?? "Too many requests.");

  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return refusal(413, "That usage report is too large.");
    raw = JSON.parse(text);
  } catch {
    return refusal(400, "Could not read the usage report.");
  }

  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join(".") || "payload";
    return refusal(400, `The ${field} field is missing or invalid.`);
  }

  const record = {
    ...redactObject(parsed.data as unknown as Record<string, unknown>),
    reportedAt: new Date().toISOString(),
  };

  console.log(`[usage] ${JSON.stringify(record)}`);
  return NextResponse.json({ ok: true }, { status: 202 });
}

function refusal(status: number, message: string) {
  return NextResponse.json({ ok: false, error: message }, { status });
}
