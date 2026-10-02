import { defineVoiceAgent, type VoiceAgentConfig } from "samai-sdk/voice";
import { VOICE_INSTRUCTIONS, VOICE_TURN_DETECTION } from "./config";
import { VOICE_TOOLS } from "./tools";

/**
 * The agent definition — SamAI SDK's orchestration layer.
 *
 * `defineVoiceAgent` is the SDK's entry point for a voice agent: it validates the config, applies
 * the interruption/VAD defaults, and hands back a `VoiceAgentConfig` that `runVoiceAgent` and the
 * realtime provider consume. Everything the model knows about this conversation lives here.
 *
 * The model and voice are supplied per-connection by the session hook rather than hardcoded, so the
 * server route remains the single source of truth for both.
 */
export function createVoiceAgent(model: string, voice: string): VoiceAgentConfig {
  return defineVoiceAgent({
    name: "SamAI Voice",
    instructions: VOICE_INSTRUCTIONS,
    model,
    voice: {
      voiceId: voice,
      /**
       * Barge-in is always allowed. `confidence-gated` would delay the cut-off until enough speech
       * was detected to be confident, which is precisely the lag that makes interruption feel
       * unresponsive. OpenAI's own VAD already suppresses blips like a cough, so the extra gate only
       * adds latency.
       */
      interruption: "always-allow",
      /** Not used on the realtime path — OpenAI's VAD decides turn boundaries — but kept coherent. */
      maxSilenceMs: 700,
      backchannel: false,
    },
    tools: VOICE_TOOLS,
  });
}

/** Exposed for the UI's turn-detection summary. */
export const turnDetection = VOICE_TURN_DETECTION;