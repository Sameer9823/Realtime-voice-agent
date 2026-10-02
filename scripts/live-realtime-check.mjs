/**
 * Live end-to-end check against OpenAI Realtime (GA).
 *
 * Mints a real client secret, opens a real WebSocket with it, replays the exact session shape the
 * app sends, and prints the assistant transcript. Verifies the client secret, the GA session.update
 * payload, and the transcript event names against the live API rather than a mock.
 *
 * Usage: node scripts/live-realtime-check.mjs
 */

const BASE = "https://api.openai.com/v1";
const key = (process.env.OPENAI_API_KEY || "").trim();
if (!key) {
  console.error("OPENAI_API_KEY is not set.");
  process.exit(2);
}

const session = {
  type: "realtime",
  model: "gpt-realtime",
  // GA accepts exactly one output modality; sending both is a 400.
  output_modalities: ["audio"],
  instructions: "You are a voice assistant. Reply with one short sentence.",
  audio: {
    input: {
      format: { type: "audio/pcm", rate: 24000 },
      transcription: { model: "gpt-4o-transcribe" },
      turn_detection: { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true },
    },
    output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
  },
};

console.log("1. minting client secret...");
const mint = await fetch(`${BASE}/realtime/client_secrets`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 600 }, session }),
});

if (!mint.ok) {
  console.error(`   mint failed ${mint.status}: ${(await mint.text()).slice(0, 400)}`);
  process.exit(1);
}
const { value: clientSecret } = await mint.json();
console.log(`   ok: ${clientSecret.slice(0, 10)}...`);

console.log("2. opening realtime websocket...");
const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime`, {
  headers: { Authorization: `Bearer ${clientSecret}` },
});

const transcript = [];
const seen = new Set();
const timer = setTimeout(() => {
  console.error(`\n   timed out. events seen: ${[...seen].join(", ") || "none"}`);
  process.exit(1);
}, 30000);

const fail = (msg) => {
  clearTimeout(timer);
  console.error(`   ${msg}`);
  process.exit(1);
};

ws.addEventListener("open", () => {
  console.log("   open. sending session.update + a user turn...");
  ws.send(JSON.stringify({ type: "session.update", session }));
  ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Say the word banana." }],
      },
    }),
  );
  ws.send(JSON.stringify({ type: "response.create" }));
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(typeof event.data === "string" ? event.data : "");
  seen.add(msg.type);

  if (msg.type === "error") {
    fail(`   realtime error: ${JSON.stringify(msg.error ?? msg).slice(0, 400)}`);
  }
  // GA emits `response.output_audio_transcript.delta`. The SDK also accepts the older
  // `response.audio_transcript.delta`, so accept both here too.
  if (msg.type === "response.output_audio_transcript.delta" || msg.type === "response.audio_transcript.delta") {
    transcript.push(msg.delta);
  }
  if (msg.type === "response.done") {
    clearTimeout(timer);
    console.log(`\n3. assistant transcript: "${transcript.join("")}"`);
    console.log(`\n   event types observed: ${[...seen].sort().join(", ")}`);
    if (transcript.join("").trim().length === 0) {
      fail("   transcript was empty — output_modalities or transcript events are wrong");
    }
    console.log("\n   PASS");
    ws.close();
    process.exit(0);
  }
});

ws.addEventListener("error", (e) => fail(`   socket error: ${e.message ?? e.type}`));
