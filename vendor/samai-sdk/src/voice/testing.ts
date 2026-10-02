import type { STTProvider, STTResult, STTSession, STTStreamOptions } from "./stt/types.js";
import type { TTSProvider, TTSSession, TTSOptions } from "./tts/types.js";

// ── Mock STT ──────────────────────────────────────────────────────────────────

export interface MockSTTChunk {
  transcript: string;
  confidence?: number;
  isFinal?: boolean;
  delayMs?: number;
}

export interface MockSTTProvider extends STTProvider {
  simulateTranscript(transcript: string, opts?: { confidence?: number; isFinal?: boolean }): void;
  simulateNoise(confidence?: number): void;
  getTranscripts(): string[];
  reset(): void;
}

export function createMockSTTProvider(opts: { chunks?: MockSTTChunk[] } = {}): MockSTTProvider {
  let onResult: ((r: STTResult) => void) | null = null;
  let onError: ((e: Error) => void) | null = null;
  const transcripts: string[] = [];
  let closed = false;

  // allow scripted chunks to be fed automatically after connect
  let scripted = opts.chunks ? [...opts.chunks] : null;

  const provider: MockSTTProvider = {
    name: "mock-stt",
    async connect(options: STTStreamOptions): Promise<STTSession & { simulateTranscript: any; simulateNoise: any }> {
      onResult = options.onResult;
      onError = options.onError ?? null;
      closed = false;
      if (scripted) {
        for (const ch of scripted) {
          if (ch.delayMs) await new Promise((r) => setTimeout(r, ch.delayMs));
          if (closed) break;
          const res: STTResult = { transcript: ch.transcript, confidence: ch.confidence ?? 0.95, isFinal: ch.isFinal ?? true };
          transcripts.push(ch.transcript);
          onResult?.(res);
        }
      }
      const sess: STTSession & { simulateTranscript: any; simulateNoise: any } = {
        sendAudio(_chunk: ArrayBuffer) {},
        async close() { closed = true; },
        simulateTranscript(transcript: string, simOpts: { confidence?: number; isFinal?: boolean } = {}) {
          if (closed) return;
          transcripts.push(transcript);
          onResult?.({ transcript, confidence: simOpts.confidence ?? 0.95, isFinal: simOpts.isFinal ?? true });
        },
        simulateNoise(confidence = 0.15) {
          if (closed) return;
          // low-confidence blip, not final, should not trigger barge-in
          onResult?.({ transcript: "cough", confidence, isFinal: false });
        },
      };
      return sess;
    },
    async transcribe(_audio: ArrayBuffer): Promise<STTResult> {
      return { transcript: transcripts[transcripts.length - 1] ?? "", confidence: 0.95, isFinal: true };
    },
    simulateTranscript(transcript: string, simOpts: { confidence?: number; isFinal?: boolean } = {}) {
      if (closed) return;
      transcripts.push(transcript);
      onResult?.({ transcript, confidence: simOpts.confidence ?? 0.95, isFinal: simOpts.isFinal ?? true });
    },
    simulateNoise(confidence = 0.15) {
      if (closed) return;
      onResult?.({ transcript: "cough", confidence, isFinal: false });
    },
    getTranscripts() { return [...transcripts]; },
    reset() { transcripts.length = 0; closed = false; scripted = opts.chunks ? [...opts.chunks] : null; },
  };
  return provider;
}

// ── Mock TTS ──────────────────────────────────────────────────────────────────

export interface MockTTSProvider extends TTSProvider {
  getSynthesized(): string[];
  getCancelled(): boolean;
  wasCancelled(): boolean;
  reset(): void;
  simulateChunk(text: string): void;
}

export function createMockTTSProvider(opts: { chunkDelayMs?: number } = {}): MockTTSProvider {
  const synthesized: string[] = [];
  let cancelled = false;
  let closed = false;
  const chunkDelayMs = opts.chunkDelayMs ?? 5;

  // per-session handlers (latest session)
  let chunkHandlers = new Set<(c: ArrayBuffer) => void>();
  let doneHandlers = new Set<() => void>();

  function makeSession(): TTSSession {
    let sessionCancelled = false;
    let sessionClosed = false;
    return {
      synthesize(text: string, _opts?: TTSOptions) {
        if (sessionClosed || sessionCancelled || cancelled || closed) return;
        synthesized.push(text);
        // simulate streaming audio chunk timing
        const ab = new TextEncoder().encode(text).buffer as ArrayBuffer;
        setTimeout(() => {
          if (sessionCancelled || sessionClosed || cancelled || closed) return;
          for (const h of [...chunkHandlers]) h(ab);
          for (const h of [...doneHandlers]) (h as any)();
        }, chunkDelayMs);
      },
      cancel() { sessionCancelled = true; cancelled = true; },
      async close() { sessionClosed = true; chunkHandlers.clear(); doneHandlers.clear(); },
      onAudioChunk(h: (c: ArrayBuffer) => void) { chunkHandlers.add(h); return () => chunkHandlers.delete(h); },
      onDone(h: () => void) { doneHandlers.add(h as any); return () => doneHandlers.delete(h as any); },
      onError(h: (e: Error) => void) { return () => {}; },
    };
  }

  return {
    name: "mock-tts",
    async connect(): Promise<TTSSession> { return makeSession(); },
    async synthesize(text: string, _opts?: TTSOptions): Promise<ArrayBuffer> {
      synthesized.push(text);
      return new TextEncoder().encode(text).buffer as ArrayBuffer;
    },
    getSynthesized() { return [...synthesized]; },
    getCancelled() { return cancelled; },
    wasCancelled() { return cancelled; },
    reset() { synthesized.length = 0; cancelled = false; closed = false; chunkHandlers.clear(); doneHandlers.clear(); },
    simulateChunk(text: string) {
      const ab = new TextEncoder().encode(text).buffer as ArrayBuffer;
      for (const h of [...chunkHandlers]) h(ab);
    },
  };
}

// ── Mock Voice Transport (in-memory duplex, stands in for WebRTC) ─────────────

export interface MockVoiceTransport {
  sendAudio(chunk: ArrayBuffer): void;
  onAudio(handler: (chunk: ArrayBuffer) => void): () => void;
  simulateRemoteAudio(chunk: ArrayBuffer): void;
  close(): void;
  isClosed(): boolean;
  getSentChunks(): ArrayBuffer[];
}

export function createMockVoiceTransport(): MockVoiceTransport {
  const handlers = new Set<(c: ArrayBuffer) => void>();
  const sent: ArrayBuffer[] = [];
  let closed = false;
  return {
    sendAudio(chunk: ArrayBuffer) { if (!closed) sent.push(chunk); },
    onAudio(handler: (chunk: ArrayBuffer) => void) { handlers.add(handler); return () => handlers.delete(handler); },
    simulateRemoteAudio(chunk: ArrayBuffer) { if (!closed) for (const h of [...handlers]) h(chunk); },
    close() { closed = true; handlers.clear(); },
    isClosed() { return closed; },
    getSentChunks() { return [...sent]; },
  };
}

// ── re-export helper so voice tests need only one import ─────────────────────
export { createMockProvider } from "../testing.js";
export type { MockProvider, MockTurn, MockProviderConfig } from "../testing.js";
