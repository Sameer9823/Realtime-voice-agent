/**
 * Server-only realtime session settings.
 *
 * Kept in its own module so it cannot be pulled into the client bundle: everything here reads
 * `process.env`, and this file is only ever imported by the route handler under `app/api/`.
 */

/** OpenAI API key. Server-side only — this is the credential that must never reach the browser. */
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || undefined;

export const realtimeModel = process.env.OPENAI_REALTIME_MODEL || undefined;
export const realtimeVoice = process.env.OPENAI_REALTIME_VOICE || undefined;
export const openAiBaseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";