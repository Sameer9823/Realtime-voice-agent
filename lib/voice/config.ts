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
 * Rules that hold for every conversation, regardless of persona or language.
 *
 * Exported as a base rather than a finished prompt because the server composes
 * `BASE_INSTRUCTIONS + persona guidance + language rule` for each session. Composing on the server
 * is what stops the client from substituting its own prompt: the finished string is returned in the
 * session response and the client replays that verbatim.
 */
export const BASE_INSTRUCTIONS = `You are a voice assistant having a live, spoken conversation. You are being heard, not read.

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

Tools:
- Use web search when the answer may have changed recently: news, prices, today's events.
- Use the documentation tool for questions about this product itself — how it works, how to configure it.
- Use the weather tool whenever anyone asks about weather or temperature.
- Call a tool at most once per question, and only when it would genuinely improve the answer. Never call one to look busy.
- Results are short text written for you to read aloud. Summarise the useful part in your own words rather than reading a result verbatim.
- If a tool fails or isn't available, say so briefly and offer an alternative. Don't retry more than once.
- Some tools ask for permission first. When one does, ask the user plainly whether you should go ahead, and wait for their answer. Never assume they said yes.

Interruption:
- The user can talk over you at any time. When you notice they've started speaking, stop talking immediately and listen. Do not finish your sentence, do not wrap up, do not say "as I was saying".
- After being interrupted, treat what they just said as the current request and respond to it.

Never:
- Don't narrate your reasoning, describe what you're about to do internally, or mention prompts, models, or how this system works.
- Don't ask the user to press a button or repeat themselves to be heard — the microphone is always live.
`;

/**
 * Default persona when a request does not name one. `friendly` is the least surprising choice for
 * someone who has not touched the settings yet.
 */
export const DEFAULT_PERSONA_ID = "friendly";

/** Default language. `auto` means match the user. */
export const DEFAULT_LANGUAGE_ID = "auto";

/**
 * Persona, language, and time range. Used by the settings panel, the agent factory, and the server
 * route. Kept separate from the prompt so it can be rendered without shipping the prompt text.
 */
export const VOICE_TURN_DETECTION = {
  type: "semantic_vad" as const,
  eagerness: "auto" as const,
  createResponse: true,
  interruptResponse: true,
};