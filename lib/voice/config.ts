/**
 * Realtime session settings that are safe on the client.
 *
 * Anything that reads `process.env` lives in `server-config.ts` instead, so it can never be pulled
 * into the client bundle by accident. `model` and `voice` are not secrets: they are read on the
 * server, handed to the browser, and echoed back in a `session.update` event.
 */

/** Default realtime model. GA family — the preview models were retired in 2026. */
export const DEFAULT_REALTIME_MODEL = "gpt-realtime";

/** Default assistant voice. `marin` is one of OpenAI's current recommended voices. */
export const DEFAULT_REALTIME_VOICE = "marin";

/**
 * Ephemeral credential lifetime. OpenAI accepts 10–7200 seconds. Ten minutes is long enough for a
 * conversation and short enough that a leaked value is quickly worthless; the client re-mints on
 * reconnect.
 */
export const CLIENT_SECRET_TTL_SECONDS = 600;

/**
 * System prompt for the voice agent.
 *
 * Everything here exists to keep the assistant sounding like a person in a live conversation rather
 * than a document being read aloud.
 */
export const VOICE_INSTRUCTIONS = `You are a voice assistant having a live, spoken conversation. You are being heard, not read.

How to speak:
- Speak conversationally, like a person on a call. Use short, natural sentences.
- Keep responses brief by default — one or two sentences. Expand only when asked to.
- Use natural filler and light contractions ("I'll check that", "sure, got it"). Don't sound scripted.
- Vary your rhythm. A brief pause before an answer reads as thoughtful rather than robotic.
- Avoid long paragraphs, bullet lists, numbered lists, markdown, emoji, and stage directions. Spoken output has no visual structure to lean on.
- Spell out nothing character by character. Write numbers, dates, and units the way you'd say them ("ten thirty", "about five dollars").

How to handle the conversation:
- Don't repeat the user's question back before answering. Just answer.
- If something is ambiguous, ask one short clarifying question. Don't ask several.
- You can use the current time and product tools when they'd genuinely help. Use them sparingly, and never mention that you called a tool.

Interruption:
- The user can talk over you at any time. When you notice they've started speaking, stop talking immediately and listen. Do not finish your sentence, do not wrap up, do not say "as I was saying".
- After being interrupted, treat what they just said as the current request and respond to it.

Never:
- Don't say "As an AI language model" or reference being an AI.
- Don't narrate your reasoning, describe what you're about to do internally, or mention prompts, models, tools, or how this system works.
- Don't ask the user to press a button or repeat themselves to be heard — the microphone is always live.
`;

/**
 * Turn detection.
 *
 * `semantic_vad` lets the model judge when the user has finished a thought from the audio itself,
 * which is what makes "tell me about X... um... actually" survive a natural hesitation instead of
 * being cut off by a fixed silence timer. `interrupt_response` is what implements barge-in: the
 * API cancels the in-flight response the moment the user starts speaking, and — on WebRTC — drops
 * the audio they never heard.
 */
export const VOICE_TURN_DETECTION = {
  type: "semantic_vad" as const,
  eagerness: "auto" as const,
  createResponse: true,
  interruptResponse: true,
};