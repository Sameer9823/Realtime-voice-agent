/**
 * Probes whether OpenAI accepts a `language` hint on the transcription config.
 *
 * `docs/sdk-notes.md` records this as unverified: the session route sends
 * `transcription: { model: "gpt-4o-transcribe", language: "<bcp47>" }` whenever the user picks a
 * specific language, and the only evidence at the time was mocked responses. This mints a real
 * ephemeral credential for each case, which is the same call that would fail if the parameter were
 * rejected, and reports the status for each.
 *
 * Usage: node scripts/probe-transcription-hint.mjs
 */

const BASE = "https://api.openai.com/v1";
const key = (process.env.OPENAI_API_KEY || "").trim();
if (!key) {
  console.error("OPENAI_API_KEY is not set.");
  process.exit(2);
}

/** Minimal session; only the transcription block varies between cases. */
function sessionWith(transcription) {
  return {
    type: "realtime",
    model: "gpt-realtime",
    output_modalities: ["audio"],
    instructions: "You are a voice assistant. Reply with one short sentence.",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription,
        turn_detection: { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true },
      },
      output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
    },
  };
}

const cases = [
  { label: "no language key (what `auto` sends)", transcription: { model: "gpt-4o-transcribe" } },
  { label: 'language: "hi" (Hindi)', transcription: { model: "gpt-4o-transcribe", language: "hi" } },
  { label: 'language: "ta" (Tamil, low-resource)', transcription: { model: "gpt-4o-transcribe", language: "ta" } },
  { label: 'language: "en-US" (BCP-47 with region)', transcription: { model: "gpt-4o-transcribe", language: "en-US" } },
  { label: 'language: "auto" (the value we deliberately do NOT send)', transcription: { model: "gpt-4o-transcribe", language: "auto" } },
  // OpenAI rejects the hint with the full list of codes it accepts, so an invalid value is the
  // cheapest way to read that list back.
  { label: 'language: "zz" (deliberately invalid, to list the supported codes)', transcription: { model: "gpt-4o-transcribe", language: "zz" } },
];

let failures = 0;

for (const testCase of cases) {
  const res = await fetch(`${BASE}/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 60 }, session: sessionWith(testCase.transcription) }),
  });

  if (res.ok) {
    console.log(`  ok    ${testCase.label} -> ${res.status} accepted`);
    continue;
  }

  const raw = await res.text();
  const message = (() => {
    try {
      return JSON.parse(raw).error?.message ?? raw;
    } catch {
      return raw;
    }
  })();
  console.log(` FAIL   ${testCase.label} -> ${res.status} ${message.slice(0, 200)}`);
  failures += 1;

  const marker = "Supported values are:";
  const at = message.indexOf(marker);
  if (at !== -1) {
    const codes = message
      .slice(at + marker.length)
      .replace(/[.\s]+$/, "")
      .split(",")
      .map((code) => code.trim().replace(/^['"]|['"]$/g, ""));
    console.log(`        codes OpenAI accepts (${codes.length}): ${codes.join(" ")}`);
  }
}

console.log(
  failures === 0
    ? "\nAll transcription shapes were accepted, including the language hint."
    : `\n${failures} shape(s) rejected.`,
);