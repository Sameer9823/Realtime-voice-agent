#!/usr/bin/env node
/**
 * Verifies that the installed `samai-sdk` carries the OpenAI Realtime GA fixes.
 *
 * This is the guard that matters: without the patch, the app installs cleanly and then fails at
 * runtime with an opaque protocol error from OpenAI, or crashes on `Buffer is not defined` in the
 * browser. Checking for the specific markers keeps that failure loud and local instead.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const voiceBundle = join(ROOT, "node_modules", "samai-sdk", "dist", "voice", "index.js");

let source;
try {
  source = readFileSync(voiceBundle, "utf8");
} catch {
  console.error("✗ could not read", voiceBundle);
  process.exit(1);
}

const checks = [
  ["realtime client-secrets minting is present", /realtime\/client_secrets/, true],
  ["GA output-audio event name is handled", /response\.output_audio\.delta/, true],
  ["GA nested session audio config is emitted", /audio:\s*\{\s*input:/, true],
  ["GA output modality is requested", /output_modalities/, true],
  ["GA realtime model is the default", /gpt-realtime/, true],
  ["input transcription is configurable", /input_audio_transcription|audio\.input\.transcription/, true],
  ["WebRTC transport ships", /OpenAIRealtimeWebRTCTransport/, true],
  ["conversation engine is exported", /ConversationEngine/, true],
  ["VAD + interruption controller are exported", /VoiceActivityDetector/, true],
  ["retired preview header is gone", /OpenAI-Beta.*v1/, false],
];

const failures = [];
for (const [label, pattern, shouldMatch] of checks) {
  const found = pattern.test(source);
  const ok = found === shouldMatch;
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
}

if (failures.length) {
  console.error(`\n${failures.length} SDK patch check(s) failed — is patches/samai-sdk+0.3.5.patch applied?`);
  process.exit(1);
}
console.log("\nsamai-sdk realtime patch verified");