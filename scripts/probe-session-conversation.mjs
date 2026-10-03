/**
 * Probe: can the session config attached to an ephemeral client secret carry conversation history?
 *
 * This decides how reconnect replay is implemented. `VoiceSession` exposes no raw `send()`, so
 * replaying history with `conversation.item.create` would need an SDK change. If OpenAI accepts a
 * `conversation` array in the session payload, the server can attach history at mint time instead
 * and no SDK change is needed.
 *
 * Usage: node scripts/probe-session-conversation.mjs
 */

const BASE = "https://api.openai.com/v1";
const key = (process.env.OPENAI_API_KEY || "").trim();
if (!key) {
  console.error("OPENAI_API_KEY is not set.");
  process.exit(2);
}

const base = {
  type: "realtime",
  model: "gpt-realtime",
  output_modalities: ["audio"],
  instructions: "Be brief.",
  audio: {
    input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-4o-transcribe" } },
    output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
  },
};

const variants = [
  {
    label: "conversation as an array of items",
    session: {
      ...base,
      conversation: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "My name is Priya." }] },
        { type: "message", role: "assistant", content: [{ type: "audio", audio: "placeholder" }] },
      ],
    },
  },
  {
    label: "conversation as an array with input_text on the assistant turn",
    session: {
      ...base,
      conversation: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "My name is Priya." }] },
        { type: "message", role: "assistant", content: [{ type: "text", text: "Nice to meet you, Priya." }] },
      ],
    },
  },
];

for (const variant of variants) {
  const response = await fetch(`${BASE}/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 120 }, session: variant.session }),
  });

  const text = await response.text();
  if (response.ok) {
    console.log(`ACCEPTED  ${variant.label}`);
  } else {
    let detail = text.slice(0, 260);
    try {
      const parsed = JSON.parse(text);
      detail = `${parsed.error?.message ?? text} (param: ${parsed.error?.param ?? "?"})`.slice(0, 260);
    } catch {}
    console.log(`REJECTED  ${variant.label}\n          ${detail}`);
  }
}