import { NextResponse } from "next/server";
import { createRealtimeClientSecret } from "samai-sdk/voice";
import {
  CLIENT_SECRET_TTL_SECONDS,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  VOICE_INSTRUCTIONS,
} from "@/lib/voice/config";
import { OPENAI_API_KEY, openAiBaseUrl, realtimeModel, realtimeVoice } from "@/lib/voice/server-config";
import { checkLimits, checkModel, checkOrigin, checkVoice, clientKey, guardFromEnv, type GuardDecision } from "@/lib/voice/guard";
import type { SessionErrorBody, SessionRequestBody, SessionResponseBody } from "@/lib/voice/types";

/**
 * Mints a short-lived OpenAI realtime client secret.
 *
 * This is the only place `OPENAI_API_KEY` is read. The browser receives an `ek_...` ephemeral value
 * that expires in minutes, so a long-lived secret never enters client-side JavaScript and a captured
 * one is worthless almost immediately.
 *
 * Run-time Node (not Edge) so the key stays in a server-only module.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Guards are built once per process. They hold the rate-limit buckets, so building them
 * per request would reset the counters and make the limit useless.
 */
const guard = guardFromEnv();

/** Renders a rejected guard decision as an HTTP response. */
function refusal(decision: GuardDecision): NextResponse<SessionErrorBody> {
  return NextResponse.json<SessionErrorBody>(
    { error: decision.code ?? "forbidden", message: decision.message ?? "Request rejected." },
    decision.retryAfterSeconds ? { status: decision.status, headers: { "Retry-After": String(decision.retryAfterSeconds) } } : { status: decision.status },
  );
}

/** Maps an upstream OpenAI failure onto a stable, user-safe category. */
function classify(status: number, body: string): SessionErrorBody {
  if (status === 401 || status === 403) {
    return { error: "auth_failed", message: "The server is not authorised to use OpenAI. Check OPENAI_API_KEY." };
  }
  if (status === 429) {
    return { error: "rate_limited", message: "OpenAI is rate limiting this account. Try again in a moment." };
  }
  if (status === 404) {
    return { error: "model_unavailable", message: "The configured realtime model is not available for this API key." };
  }
  if (/model/i.test(body)) {
    return { error: "model_unavailable", message: "The configured realtime model is not available for this API key." };
  }
  return { error: "session_failed", message: "Could not start a realtime session. Please try again." };
}

export async function POST(request: Request) {
  const origin = checkOrigin(request.headers.get("origin"), guard.allowedOrigins);
  if (!origin.ok) return refusal(origin);

  const limits = await checkLimits(clientKey(request), guard);
  if (!limits.ok) return refusal(limits);

  const apiKey = OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json<SessionErrorBody>(
      {
        error: "auth_failed",
        message: "OPENAI_API_KEY is not configured on the server.",
      },
      { status: 500 },
    );
  }

  let body: SessionRequestBody = {};
  try {
    body = (await request.json()) as SessionRequestBody;
  } catch {
    // An empty body is fine — the server defaults apply.
  }

  const model = body.model || realtimeModel || DEFAULT_REALTIME_MODEL;
  const voice = body.voice || realtimeVoice || DEFAULT_REALTIME_VOICE;

  const voiceCheck = checkVoice(voice);
  if (!voiceCheck.ok) return refusal(voiceCheck);

  const modelCheck = checkModel(model);
  if (!modelCheck.ok) return refusal(modelCheck);

  try {
    const { value, expiresAt } = await createRealtimeClientSecret({
      apiKey,
      model,
      // Session config attached to the secret is applied to every session created with it, so the
      // client does not have to configure the session before its first turn.
      session: {
        // Attached to the secret, so the model already has its instructions and turn detection
        // before the client's data channel opens. The client re-sends an equivalent session.update
        // over the data channel; sending it here just removes that from the critical path.
        instructions: VOICE_INSTRUCTIONS,
        // GA accepts exactly one output modality: `["text"]` or `["audio"]`; sending both is a 400.
        // Audio costs nothing in captioning: the assistant transcript still arrives on
        // `response.output_audio_transcript.delta`.
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            // Required, otherwise no user transcripts are ever produced.
            transcription: { model: "gpt-4o-transcribe" },
            turn_detection: {
              type: "semantic_vad",
              eagerness: "auto",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice },
        },
      },
      ttlSeconds: CLIENT_SECRET_TTL_SECONDS,
      baseUrl: openAiBaseUrl,
    });

    return NextResponse.json<SessionResponseBody>({ clientSecret: value, expiresAt, model, voice });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statusMatch = /\((\d{3})/.exec(message);
    const status = statusMatch ? Number(statusMatch[1]) : 502;
    console.error("[realtime/session] failed to mint client secret:", message);
    return NextResponse.json<SessionErrorBody>(classify(status, message), { status: status >= 400 && status < 600 ? status : 502 });
  }
}