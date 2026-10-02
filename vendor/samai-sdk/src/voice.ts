// ⚠️ VERIFICATION NOTE (read before relying on this in production)
// This module talks to OpenAI's TTS, transcription, and Realtime APIs. `api.openai.com` is not
// reachable from the sandbox this file was written in, so — unlike the rest of this SDK's
// integrations, which were exercised against a real running server or process before being
// considered done — none of the three exports below have been run against a live OpenAI
// connection. The REST calls (`generateSpeech`, `transcribeAudio`) are low-risk: they're a
// straightforward `fetch()` following OpenAI's documented request/response shape, the same
// pattern as `createWebSearchTool()`'s Tavily/Brave calls, which *are* verified.
//
// The realtime session below targets the Realtime API **GA** protocol (the preview protocol was
// retired in 2026): nested `audio.input`/`audio.output` session config, `session.type: "realtime"`,
// `response.output_*` server event names, ephemeral client secrets, and no `OpenAI-Beta` header.
// Because GA and preview names overlap in some gateways, the server-event handler accepts both.
// It still has not been exercised against a live key, so test it before shipping.
import type { ToolDefinition } from "./types.js";
import { toolParametersJsonSchema } from "./schema-adapter.js";
import { base64ToBytes, bytesToBase64, type BinaryLike } from "./bytes.js";

// ---------- Text-to-speech ----------

export type TTSVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" | (string & {});
export type TTSFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

export interface GenerateSpeechOptions {
  /** Text to synthesize. */
  input: string;
  /** API key. Falls back to `OPENAI_API_KEY`. */
  apiKey?: string;
  /** TTS model. Default: "tts-1". */
  model?: string;
  /** Voice preset. Default: "alloy". */
  voice?: TTSVoice;
  /** Output audio format. Default: "mp3". */
  format?: TTSFormat;
  /** Playback speed, 0.25–4.0. Default: 1.0. */
  speed?: number;
  /** Base URL, for Azure OpenAI or a proxy. Default: "https://api.openai.com/v1". */
  baseURL?: string;
  timeoutMs?: number;
}

export interface GenerateSpeechResult {
  /** Raw audio bytes in the requested `format`. */
  audio: Buffer;
  contentType: string;
}

/**
 * Synthesizes speech from text via OpenAI's `/audio/speech` endpoint. Makes a real HTTP request
 * — not a stub — and requires an API key (`OPENAI_API_KEY` or `{ apiKey }`).
 *
 * Usage:
 *   const { audio } = await generateSpeech({ input: "Hello there!", voice: "nova" });
 *   await fs.writeFile("out.mp3", audio);
 */
export async function generateSpeech(options: GenerateSpeechOptions): Promise<GenerateSpeechResult> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("generateSpeech() has no API key. Pass { apiKey }, or set OPENAI_API_KEY in the environment.");
  }
  const baseURL = options.baseURL ?? "https://api.openai.com/v1";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  try {
    const res = await fetch(`${baseURL}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: options.model ?? "tts-1",
        input: options.input,
        voice: options.voice ?? "alloy",
        response_format: options.format ?? "mp3",
        speed: options.speed,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`generateSpeech() failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => "")}`);
    }
    const contentType = res.headers.get("content-type") ?? `audio/${options.format ?? "mpeg"}`;
    const arrayBuffer = await res.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), contentType };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Speech-to-text ----------

export interface TranscribeAudioOptions {
  /** Audio bytes to transcribe (any format the API accepts: mp3, wav, m4a, webm, etc). */
  audio: Buffer;
  /** Filename hint for the multipart upload — its extension tells the API the audio format. Default: "audio.wav". */
  filename?: string;
  /** API key. Falls back to `OPENAI_API_KEY`. */
  apiKey?: string;
  /** Transcription model. Default: "whisper-1". */
  model?: string;
  /** Optional ISO-639-1 language hint (e.g. "en") to improve accuracy/speed. */
  language?: string;
  /** Optional prompt to bias transcription (e.g. domain vocabulary, or the prior transcript for continuity). */
  prompt?: string;
  /** Base URL, for Azure OpenAI or a proxy. Default: "https://api.openai.com/v1". */
  baseURL?: string;
  timeoutMs?: number;
}

export interface TranscribeAudioResult {
  text: string;
}

/**
 * Transcribes audio to text via OpenAI's `/audio/transcriptions` endpoint (Whisper). Makes a
 * real HTTP request — not a stub — and requires an API key (`OPENAI_API_KEY` or `{ apiKey }`).
 *
 * Usage:
 *   const { text } = await transcribeAudio({ audio: await fs.readFile("recording.mp3"), filename: "recording.mp3" });
 */
export async function transcribeAudio(options: TranscribeAudioOptions): Promise<TranscribeAudioResult> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("transcribeAudio() has no API key. Pass { apiKey }, or set OPENAI_API_KEY in the environment.");
  }
  const baseURL = options.baseURL ?? "https://api.openai.com/v1";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);

  try {
    const form = new FormData();
    form.append("model", options.model ?? "whisper-1");
    if (options.language) form.append("language", options.language);
    if (options.prompt) form.append("prompt", options.prompt);
    const filename = options.filename ?? "audio.wav";
    const blob = new Blob([new Uint8Array(options.audio)], { type: guessAudioMimeType(filename) });
    form.append("file", blob, filename);

    const res = await fetch(`${baseURL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`transcribeAudio() failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => "")}`);
    }
    const data = (await res.json()) as { text: string };
    return { text: data.text };
  } finally {
    clearTimeout(timer);
  }
}

function guessAudioMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    webm: "audio/webm",
    ogg: "audio/ogg",
    flac: "audio/flac",
  };
  return (ext && map[ext]) || "application/octet-stream";
}

// ---------- Realtime voice sessions ----------

/** Linear/companded audio codec used on the realtime wire. */
export type RealtimeAudioEncoding = "pcm16" | "g711_ulaw" | "g711_alaw";

export type RealtimeConnectionState = "connecting" | "connected" | "closed" | "failed";

/**
 * Turn detection config. `server_vad` is energy/silence based; `semantic_vad` lets the model infer
 * turn boundaries semantically and takes `eagerness` instead of a silence threshold.
 */
export interface RealtimeTurnDetection {
  type?: "server_vad" | "semantic_vad";
  /** server_vad: voice-detection threshold, 0–1. Default 0.5. */
  threshold?: number;
  /** server_vad: how long the user must be silent before the turn is committed, ms. Default 500. */
  silenceDurationMs?: number;
  /** server_vad: extra pre-roll audio kept before speech started, ms. Default 300. */
  prefixPaddingMs?: number;
  /** semantic_vad: how eagerly the model decides the turn ended. Default "auto". */
  eagerness?: "low" | "medium" | "high" | "auto";
  /** When false, VAD still detects turns but the client must send `response.create` itself. Default true. */
  createResponse?: boolean;
  /**
   * When true (default), server VAD cancels an in-flight assistant response as soon as the user
   * starts speaking — this is the barge-in behavior. Set false to handle interruption manually.
   */
  interruptResponse?: boolean;
  /** Optional id, echoed back on the events this turn detection produces. */
  id?: string;
}

export interface RealtimeInputTranscription {
  /** Transcription model id, e.g. "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1". */
  model?: string;
  language?: string;
  prompt?: string;
}

export interface RealtimeSessionOptions {
  /**
   * Long-lived OpenAI API key. Falls back to `OPENAI_API_KEY`. Server-side only — do NOT ship this
   * to a browser. Prefer `clientSecret`/`getEphemeralKey` for any client environment.
   */
  apiKey?: string;
  /**
   * Ephemeral client secret from `POST /v1/realtime/client_secrets` (an `ek_...` value). This is the
   * browser-safe credential: mint it on your server, hand it to the client, connect.
   */
  clientSecret?: string;
  /** Lazily mint an ephemeral client secret, e.g. when reconnecting past its expiry. */
  getEphemeralKey?: () => Promise<string>;
  /** Realtime model. Default: "gpt-realtime" — always check OpenAI's current model list. */
  model?: string;
  /** Voice preset for the assistant's spoken responses. Default: "alloy". */
  voice?: TTSVoice;
  /** System instructions for the session. */
  instructions?: string;
  /**
   * Tools available to the model during the session. When a tool call comes in, it's executed
   * automatically (via each `ToolDefinition.execute()`) and the result is sent back to continue
   * the response — you don't need to handle `tool_call` events yourself unless you want to
   * observe them (they're still emitted, informationally, alongside the auto-execution).
   */
  tools?: ToolDefinition[];
  /**
   * Turn detection config, or `null` to disable it (manual turn-taking — you decide when to call
   * `commitAudio()`). Default: `semantic_vad` with OpenAI's defaults, which is what makes natural
   * turn-taking and barge-in work without a push-to-talk button.
   */
  turnDetection?: RealtimeTurnDetection | null;
  /**
   * Input-audio transcription config. Required to receive
   * `conversation.item.input_audio_transcription.*` events (and therefore user transcripts).
   * Pass `null` to disable transcription of the user's audio. Default: `{ model: "gpt-4o-transcribe" }`.
   */
  inputAudioTranscription?: RealtimeInputTranscription | null;
  /** Input audio encoding sent via `sendAudio()`. Default: "pcm16" (24kHz, mono, little-endian). */
  inputAudioFormat?: RealtimeAudioEncoding;
  /** Output audio encoding received in `audio.delta` events. Default: "pcm16". */
  outputAudioFormat?: RealtimeAudioEncoding;
  /** Input noise reduction. Default: `{ type: "near_field" }`. */
  inputNoiseReduction?: { type: "near_field" | "far_field" } | null;
  /** Realtime endpoint override — e.g. an Azure OpenAI realtime deployment URL, or a relay/proxy. Default: OpenAI's `wss://api.openai.com/v1/realtime`. */
  url?: string;
  /** Extra headers for the WebSocket handshake (some environments need these instead of/alongside the Authorization header). */
  headers?: Record<string, string>;
  /**
   * Which realtime wire protocol to speak. "ga" (default) is the current GA interface; "v1" is the
   * retired preview interface, kept for gateways and Azure deployments pinned to it.
   */
  protocol?: "ga" | "v1";
  /** How long `connect()` waits for the server to acknowledge the session. Default 15000ms. */
  connectTimeoutMs?: number;
}

export type RealtimeEvent =
  | { type: "session.ready" }
  | { type: "audio.delta"; audio: Uint8Array }
  | { type: "audio.done" }
  | { type: "transcript.delta"; delta: string; role: "assistant" | "user" }
  | { type: "transcript.done"; transcript: string; role: "assistant" | "user" }
  | { type: "text.delta"; delta: string }
  | { type: "text.done"; text: string }
  /** Server VAD detected the user starting to talk. A good moment to stop local audio playback. */
  | { type: "speech_started" }
  | { type: "speech_stopped" }
  | { type: "response.done" }
  /** The assistant's in-flight response was cancelled (barge-in, or an explicit `interrupt()`). */
  | { type: "response.cancelled" }
  | { type: "tool_call"; name: string; args: unknown; callId: string }
  | { type: "error"; error: unknown }
  /** Transport lifecycle, for reconnect and teardown logic. */
  | { type: "connection"; state: RealtimeConnectionState; reason?: string; code?: number }
  /** Anything not mapped above, passed through unmodified so nothing is silently dropped as the API evolves. */
  | { type: "raw"; event: unknown };

export interface RealtimeSession {
  /** Opens the connection and configures the session. Resolves once the server confirms the session is ready. */
  connect(): Promise<void>;
  /** Appends a chunk of input audio (raw bytes matching `inputAudioFormat`) to the input buffer. */
  sendAudio(chunk: Uint8Array | ArrayBuffer): void;
  /** Manually signals end-of-turn. Unnecessary (and a no-op) when server VAD is enabled — the server commits automatically. */
  commitAudio(): void;
  /** Sends a text message as the user's turn and asks the model to respond. */
  sendText(text: string): void;
  /** Cancels the assistant's in-flight response — call this the instant you detect the user talking over it. */
  interrupt(): void;
  /**
   * Drops the unplayed tail of the assistant's last response from the conversation. WebRTC does this
   * server-side automatically; a WebSocket client owns its own playback buffer and must call this so
   * the model doesn't later speak words the user never heard.
   */
  truncateLastResponse(audioEndMs: number): void;
  /** Current transport state. */
  getConnectionState(): RealtimeConnectionState;
  /** Subscribes to session events. Returns an unsubscribe function. */
  on(handler: (event: RealtimeEvent) => void): () => void;
  /** Sends a raw client event straight through, for anything this wrapper doesn't cover yet. See OpenAI's Realtime API event reference for the shape. */
  sendRaw(event: Record<string, unknown>): void;
  close(): Promise<void>;
}

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

interface WebSocketBinding {
  ctor: new (url: string, protocols?: string[], opts?: unknown) => WebSocketLike;
  /** Whether this implementation can send custom handshake headers (`ws` can; the standard, browser-spec-compliant global `WebSocket` cannot — browsers never allow it, and Node's built-in implementation follows the same spec). */
  supportsHeaders: boolean;
}

/**
 * Picks a WebSocket implementation.
 *
 * The global `WebSocket` is preferred: it exists in browsers, in edge runtimes, and in Node 22+, and
 * it is what every client environment already has. `ws` is only used as a fallback for older Node
 * builds, and only because it can send custom handshake headers — the global implementation
 * cannot, so when it is used we authenticate via subprotocols instead, which is OpenAI's documented
 * approach for header-less environments.
 */
async function getWebSocketBinding(): Promise<WebSocketBinding> {
  if (typeof WebSocket !== "undefined") {
    return { ctor: WebSocket as unknown as WebSocketBinding["ctor"], supportsHeaders: false };
  }
  try {
    const mod = await import("ws");
    const ctor = (mod.WebSocket ?? mod.default) as unknown as WebSocketBinding["ctor"];
    if (typeof ctor === "function") return { ctor, supportsHeaders: true };
  } catch {
    /* fall through to the error below */
  }
  throw new Error(
    "createRealtimeSession() needs a WebSocket implementation. Browsers, edge runtimes and Node 22+ " +
      "have one built in; for older Node, install the optional `ws` package (`npm install ws`). " +
      "In a browser, prefer the WebRTC transport (see openaiRealtime({ transport: \"webrtc\" }))."
  );
}

/** Maps this SDK's codec names onto the GA realtime `audio.*.format` object. */
function toWireAudioFormat(encoding: RealtimeAudioEncoding): { type: string; rate?: number } {
  switch (encoding) {
    case "g711_ulaw":
      return { type: "audio/pcmu" };
    case "g711_alaw":
      return { type: "audio/pcma" };
    case "pcm16":
    default:
      return { type: "audio/pcm", rate: 24000 };
  }
}

/** Bytes-per-second for the given codec, used to turn a played byte count into `audio_end_ms`. */
function bytesPerSecond(encoding: RealtimeAudioEncoding): number {
  // pcm16 mono @ 24kHz = 2 bytes/sample * 24000 samples/sec. G.711 is 1 byte/sample @ 8kHz.
  switch (encoding) {
    case "g711_ulaw":
    case "g711_alaw":
      return 8000;
    case "pcm16":
    default:
      return 48000;
  }
}

/** Drops `undefined` entries so the wire payload only carries fields the caller actually set. */
function compact<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Builds the `session` payload for `session.update`, in GA or retired-preview shape. */
function buildSessionConfig(options: RealtimeSessionOptions): Record<string, unknown> {
  const inputFormat = options.inputAudioFormat ?? "pcm16";
  const outputFormat = options.outputAudioFormat ?? "pcm16";
  const transcription =
    options.inputAudioTranscription === null
      ? undefined
      : compact({ model: options.inputAudioTranscription?.model ?? "gpt-4o-transcribe", language: options.inputAudioTranscription?.language, prompt: options.inputAudioTranscription?.prompt });
  const tools = (options.tools ?? []).map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: toolParametersJsonSchema(t),
  }));

  if (options.protocol === "v1") {
    const turn = options.turnDetection === undefined ? ({ type: "server_vad" } as RealtimeTurnDetection) : options.turnDetection;
    return compact({
      model: options.model,
      modalities: ["text", "audio"],
      instructions: options.instructions,
      voice: options.voice ?? "alloy",
      input_audio_format: inputFormat,
      output_audio_format: outputFormat,
      input_audio_transcription: transcription,
      turn_detection:
        turn === null
          ? null
          : compact({
              type: turn.type ?? "server_vad",
              threshold: turn.threshold,
              silence_duration_ms: turn.silenceDurationMs,
              prefix_padding_ms: turn.prefixPaddingMs,
              create_response: turn.createResponse,
              interrupt_response: turn.interruptResponse,
              id: turn.id,
            }),
      tools,
      tool_choice: "auto",
    });
  }

  // GA: everything audio-related is nested under `audio.input` / `audio.output`.
  // `turnDetection: null` disables VAD; leaving it unset turns on the semantic default, which is
  // what lets a user talk naturally without a push-to-talk button.
  const turn = options.turnDetection === undefined ? ({ type: "semantic_vad" } as RealtimeTurnDetection) : options.turnDetection;
  return compact({
    type: "realtime",
    model: options.model,
    // GA accepts exactly one output modality: `["text"]` or `["audio"]`. Requesting both is a 400.
    // Audio is the correct choice for a voice agent, and it does not cost us captions: the
    // assistant transcript still arrives on `response.output_audio_transcript.delta`.
    output_modalities: ["audio"],
    instructions: options.instructions,
    audio: {
      input: compact({
        format: toWireAudioFormat(inputFormat),
        transcription,
        noise_reduction: options.inputNoiseReduction === null ? undefined : (options.inputNoiseReduction ?? { type: "near_field" }),
        turn_detection:
          turn === null
            ? null
            : compact({
                type: turn.type ?? "semantic_vad",
                // server_vad fields
                threshold: turn.threshold,
                silence_duration_ms: turn.silenceDurationMs,
                prefix_padding_ms: turn.prefixPaddingMs,
                // semantic_vad field
                eagerness: turn.eagerness,
                create_response: turn.createResponse,
                interrupt_response: turn.interruptResponse,
                id: turn.id,
              }),
      }),
      output: {
        format: toWireAudioFormat(outputFormat),
        voice: options.voice ?? "alloy",
      },
    },
    tools,
    tool_choice: "auto",
  });
}

/**
 * Opens a realtime, bidirectional voice session against OpenAI's Realtime API — send audio or
 * text in, get streamed audio/text/transcript deltas back, with server-side voice-activity
 * detection and interruption handling. This is the WebSocket transport; for browser apps prefer the
 * WebRTC transport (`openaiRealtime({ transport: "webrtc" })`), which lets the browser hand its mic
 * and speaker tracks to the API directly instead of base64-encoding PCM over a socket.
 *
 * See the module-level comment at the top of this file for the current verification status —
 * this hasn't been run against a live OpenAI connection from the environment it was written in.
 *
 * Usage (text in, audio out):
 *   const session = createRealtimeSession({
 *     instructions: "You are a helpful, concise voice assistant.",
 *     voice: "alloy",
 *     tools: [getWeatherTool],
 *   });
 *   session.on((event) => {
 *     if (event.type === "audio.delta") playAudioChunk(event.audio); // your speaker output
 *     if (event.type === "transcript.delta") process.stdout.write(event.delta);
 *   });
 *   await session.connect();
 *   session.sendText("What's the weather in Tokyo?");
 *   // ...later:
 *   await session.close();
 *
 * Usage (mic audio in, with barge-in interruption):
 *   micStream.on("data", (chunk) => session.sendAudio(chunk));
 *   session.on((event) => {
 *     if (event.type === "speech_started") session.truncateLastResponse(playedMs);
 *   });
 */
export function createRealtimeSession(options: RealtimeSessionOptions = {}): RealtimeSession {
  const apiKey = options.apiKey ?? (typeof process !== "undefined" ? process.env?.OPENAI_API_KEY : undefined);
  const model = options.model ?? "gpt-realtime";
  const outputFormat = options.outputAudioFormat ?? "pcm16";

  const listeners = new Set<(event: RealtimeEvent) => void>();
  const toolsByName = new Map((options.tools ?? []).map((t) => [t.name, t]));

  let ws: WebSocketLike | null = null;
  let connectionState: RealtimeConnectionState = "connecting";
  /** Function calls already executed, so the two events OpenAI emits per call don't run it twice. */
  const handledCallIds = new Set<string>();
  /** Most recent assistant conversation item, needed to truncate unplayed audio on barge-in. */
  let lastAssistantItemId: string | null = null;
  /** Bytes of assistant audio handed to the caller, i.e. approximately what has been played. */
  let assistantAudioBytes = 0;

  function emit(event: RealtimeEvent): void {
    for (const listener of listeners) listener(event);
  }

  function send(event: Record<string, unknown>): void {
    if (!ws || ws.readyState !== 1 /* OPEN */) {
      throw new Error("RealtimeSession: not connected. Call connect() first and await it before sending.");
    }
    ws.send(JSON.stringify(event));
  }

  /** Like `send`, but never throws. Used from teardown/interrupt paths where the socket may already be gone. */
  function sendQuiet(event: Record<string, unknown>): void {
    try {
      send(event);
    } catch {
      /* connection already gone */
    }
  }

  function truncateLastResponse(audioEndMs: number): void {
    if (!lastAssistantItemId) return;
    sendQuiet({
      type: "conversation.item.truncate",
      item_id: lastAssistantItemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.round(audioEndMs)),
    });
  }

  async function handleFunctionCall(name: string, callId: string, argsJson: string): Promise<void> {
    if (callId && handledCallIds.has(callId)) return;
    if (callId) handledCallIds.add(callId);
    const tool = toolsByName.get(name);
    let output: string;
    if (!tool) {
      output = JSON.stringify({ error: `No tool named "${name}" is registered on this session.` });
    } else {
      try {
        const args = JSON.parse(argsJson || "{}");
        emit({ type: "tool_call", name, args, callId });
        const result = await tool.execute(args);
        output = typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        output = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    sendQuiet({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
    sendQuiet({ type: "response.create" });
  }

  function noteAssistantItem(item: unknown): void {
    if (!item || typeof item !== "object") return;
    const it = item as { type?: string; role?: string; id?: string };
    if (it.type === "message" && it.role === "assistant" && typeof it.id === "string") {
      lastAssistantItemId = it.id;
      assistantAudioBytes = 0;
    }
  }

  /** Reads a `function_call` output item off `response.output_item.done`, if that is what it is. */
  function asFunctionCall(item: unknown): { name: string; callId: string; args: string } | null {
    if (!item || typeof item !== "object") return null;
    const it = item as { type?: string; name?: string; call_id?: string; arguments?: string };
    if (it.type !== "function_call") return null;
    return { name: it.name ?? "", callId: it.call_id ?? "", args: it.arguments ?? "{}" };
  }

  function handleServerEvent(raw: string, onReady?: () => void): void {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "session.created":
      case "session.updated":
        emit({ type: "session.ready" });
        onReady?.();
        break;

      // --- assistant audio. GA names first; preview names kept for pinned gateways. ---
      case "response.output_audio.delta":
      case "response.audio.delta":
        emit({ type: "audio.delta", audio: base64ToBytes(msg.delta as string) });
        assistantAudioBytes += typeof msg.delta === "string" ? Math.floor((msg.delta.length * 3) / 4) : 0;
        break;
      case "response.output_audio.done":
      case "response.audio.done":
        emit({ type: "audio.done" });
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        emit({ type: "transcript.delta", delta: msg.delta as string, role: "assistant" });
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        emit({ type: "transcript.done", transcript: msg.transcript as string, role: "assistant" });
        break;

      // --- assistant text ---
      case "response.output_text.delta":
      case "response.text.delta":
        emit({ type: "text.delta", delta: msg.delta as string });
        break;
      case "response.output_text.done":
      case "response.text.done":
        emit({ type: "text.done", text: msg.text as string });
        break;

      // --- user audio transcription (requires session inputAudioTranscription) ---
      case "conversation.item.input_audio_transcription.delta":
        emit({ type: "transcript.delta", delta: msg.delta as string, role: "user" });
        break;
      case "conversation.item.input_audio_transcription.completed":
        emit({ type: "transcript.done", transcript: msg.transcript as string, role: "user" });
        break;

      // --- turn detection ---
      case "input_audio_buffer.speech_started":
        emit({ type: "speech_started" });
        break;
      case "input_audio_buffer.speech_stopped":
        emit({ type: "speech_stopped" });
        break;

      // --- response lifecycle ---
      case "response.cancelled":
        emit({ type: "response.cancelled" });
        break;
      case "response.done":
        emit({ type: "response.done" });
        break;

      // --- function calling. Both events carry the same call; handledCallIds de-dupes. ---
      case "response.function_call_arguments.done":
        void handleFunctionCall(msg.name as string, msg.call_id as string, msg.arguments as string);
        break;
      case "response.output_item.done": {
        noteAssistantItem(msg.item);
        const call = asFunctionCall(msg.item);
        if (call) void handleFunctionCall(call.name, call.callId, call.args);
        break;
      }
      case "response.output_item.added":
        noteAssistantItem(msg.item);
        break;
      case "conversation.item.added":
      case "conversation.item.created":
        noteAssistantItem(msg.item);
        break;

      case "error":
        emit({ type: "error", error: msg.error ?? msg });
        break;
      default:
        emit({ type: "raw", event: msg });
    }
  }

  return {
    async connect() {
      if (connectionState === "connected") return;

      // An ephemeral client secret (ek_...) may be minted per connection, which matters on reconnect.
      let credential = options.clientSecret;
      if (!credential && !options.url) {
        if (options.getEphemeralKey) {
          credential = await options.getEphemeralKey();
        } else if (apiKey) {
          credential = apiKey;
        }
      }
      if (!credential && !options.url) {
        throw new Error(
          "createRealtimeSession() has no credential. Pass { clientSecret } (an ephemeral ek_... value " +
            "from POST /v1/realtime/client_secrets) or { apiKey } / OPENAI_API_KEY, or pass a { url } " +
            "(e.g. a proxy) that doesn't need one."
        );
      }

      const WS = await getWebSocketBinding();
      const headers: Record<string, string> = {
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...options.headers,
      };
      // The header-based auth path only exists when `ws` is available; on the spec-compliant global
      // WebSocket we use subprotocols instead, since browsers cannot set custom handshake headers.
      const bearer = credential ? (credential.startsWith("ek_") ? credential : `openai-insecure-api-key.${credential}`) : undefined;
      const protocols = WS.supportsHeaders
        ? undefined
        : ["realtime", ...(bearer ? [bearer] : []), "openai-beta.realtime-v1"];

      connectionState = "connecting";
      emit({ type: "connection", state: "connecting" });

      await new Promise<void>((resolvePromise, reject) => {
        const socket = WS.supportsHeaders
          ? new WS.ctor(options.url ?? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, undefined, { headers })
          : new WS.ctor(options.url ?? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, protocols);
        ws = socket;
        let settled = false;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };

        const timer = setTimeout(() => {
          const err = new Error(
            `Realtime session was not acknowledged within ${options.connectTimeoutMs ?? 15000}ms.`
          );
          connectionState = "failed";
          emit({ type: "connection", state: "failed", reason: "timeout" });
          emit({ type: "error", error: err });
          try {
            socket.close();
          } catch {
            /* already closing */
          }
          finish(() => reject(err));
        }, options.connectTimeoutMs ?? 15000);

        socket.addEventListener("open", () => {
          try {
            send({ type: "session.update", session: buildSessionConfig(options) });
          } catch (err) {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          }
          // Deliberately NOT resolving here — session.update having been *sent* doesn't mean the
          // server has *applied* it yet. connect() resolves from the message handler below, once a
          // session.created/session.updated event actually comes back.
        });
        socket.addEventListener("message", (event: { data: unknown }) => {
          handleServerEvent(typeof event.data === "string" ? event.data : String(event.data), () => {
            connectionState = "connected";
            emit({ type: "connection", state: "connected" });
            finish(() => resolvePromise());
          });
        });
        socket.addEventListener("error", (event: unknown) => {
          const err = event instanceof Error ? event : new Error("RealtimeSession WebSocket error");
          emit({ type: "error", error: err });
          if (connectionState !== "closed") {
            connectionState = "failed";
            emit({ type: "connection", state: "failed", reason: "transport-error" });
          }
          finish(() => reject(err));
        });
        socket.addEventListener("close", (event: { code?: number; reason?: string } | undefined) => {
          if (ws === socket) ws = null;
          if (connectionState === "closed") return;
          connectionState = "closed";
          emit({ type: "connection", state: "closed", code: event?.code, reason: event?.reason });
          // A close before the session was acknowledged means connect() never resolves; fail it.
          finish(() => reject(new Error("Realtime connection closed before the session was ready.")));
        });
      });
    },

    sendAudio(chunk: Uint8Array | ArrayBuffer) {
      send({ type: "input_audio_buffer.append", audio: bytesToBase64(chunk) });
    },

    commitAudio() {
      send({ type: "input_audio_buffer.commit" });
    },

    sendText(text: string) {
      send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      });
      send({ type: "response.create" });
    },

    interrupt() {
      sendQuiet({ type: "response.cancel" });
      // Drop whatever the user never got to hear so the model's memory of its own turn matches
      // what was actually played. WebRTC does this server-side; a WebSocket client owns the buffer.
      truncateLastResponse((assistantAudioBytes / bytesPerSecond(outputFormat)) * 1000);
      assistantAudioBytes = 0;
      lastAssistantItemId = null;
    },

    truncateLastResponse,

    getConnectionState() {
      return connectionState;
    },

    on(handler: (event: RealtimeEvent) => void) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },

    sendRaw(event: Record<string, unknown>) {
      send(event);
    },

    async close() {
      if (!ws) {
        connectionState = "closed";
        return;
      }
      const socket = ws;
      ws = null;
      connectionState = "closed";
      emit({ type: "connection", state: "closed", reason: "client-close" });
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    },
  };
}
