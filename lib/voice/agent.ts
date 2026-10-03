import { defineVoiceAgent, type VoiceAgentConfig } from "samai-sdk/voice";
import { VOICE_TURN_DETECTION } from "./config";
import { VOICE_TOOLS } from "./tools";

/**
 * The agent definition — the SDK's orchestration layer.
 *
 * `defineVoiceAgent` validates the config, applies the interruption/VAD defaults, and hands back a
 * `VoiceAgentConfig` that `runVoiceAgent` and the realtime provider consume.
 *
 * `instructions` arrives from the session route rather than being composed here. That is what stops
 * the browser from choosing its own system prompt: the server resolved the persona and language,
 * and this only replays the string it handed back.
 */
export function createVoiceAgent(model: string, voice: string, instructions: string): VoiceAgentConfig {
  return defineVoiceAgent({
    name: "Voice Agent",
    model,
    instructions,
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