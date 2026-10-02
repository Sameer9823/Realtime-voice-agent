import type { TTSProvider, TTSSession, TTSOptions } from "./types.js";

type Handler<T> = (v: T) => void;

export function elevenLabsTTS(config: { apiKey?: string; voiceId?: string; model?: string } = {}): TTSProvider {
  const voiceId = config.voiceId ?? "21m00Tcm4TlvDq8ikWAM";
  const model = config.model ?? "eleven_multilingual_v2";

  async function createSession(isMock: boolean, sdkClient: any): Promise<TTSSession> {
    const chunkHandlers = new Set<Handler<ArrayBuffer>>();
    const doneHandlers = new Set<Handler<void>>();
    const errorHandlers = new Set<Handler<Error>>();
    let cancelled = false;
    let closed = false;
    const emitChunk = (c: ArrayBuffer) => { if (!cancelled && !closed) chunkHandlers.forEach((h) => h(c)); };
    const emitDone = () => { if (!cancelled && !closed) doneHandlers.forEach((h) => (h as any)()); };
    const emitError = (e: Error) => errorHandlers.forEach((h) => h(e));
    return {
      synthesize(text: string, opts?: TTSOptions) {
        if (closed || cancelled) return;
        const vid = opts?.voiceId ?? voiceId;
        const mid = (opts as any)?.model ?? model;
        if (isMock || !sdkClient) {
          queueMicrotask(() => {
            if (cancelled || closed) return;
            emitChunk(new TextEncoder().encode(text).buffer as ArrayBuffer);
            emitDone();
          });
          return;
        }
        (async () => {
          try {
            let stream: any = null;
            if (sdkClient.textToSpeech?.convertAsStream) {
              stream = await sdkClient.textToSpeech.convertAsStream(vid, { text, model_id: mid });
            } else if (sdkClient.textToSpeech?.convert) {
              const buf: any = await sdkClient.textToSpeech.convert(vid, { text, model_id: mid });
              const ab = buf instanceof ArrayBuffer ? buf : buf?.buffer ?? new TextEncoder().encode(String(buf)).buffer;
              emitChunk(ab as ArrayBuffer); emitDone(); return;
            } else if (sdkClient.generate) {
              const buf: any = await sdkClient.generate({ voice: vid, text, model_id: mid });
              const ab = buf instanceof ArrayBuffer ? buf : new TextEncoder().encode(String(buf)).buffer;
              emitChunk(ab as ArrayBuffer); emitDone(); return;
            }
            if (!stream) throw new Error("ElevenLabs SDK shape not recognized");
            if (stream[Symbol.asyncIterator]) {
              for await (const chunk of stream) {
                if (cancelled || closed) break;
                const ab = chunk instanceof Uint8Array ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset+chunk.byteLength) : chunk;
                emitChunk(ab as ArrayBuffer);
              }
              emitDone();
            } else if (typeof stream.on === "function") {
              stream.on("data", (c: any) => emitChunk(c instanceof Uint8Array ? c.buffer as ArrayBuffer : c));
              stream.on("end", emitDone);
              stream.on("error", (e: any) => emitError(e instanceof Error ? e : new Error(String(e))));
            } else {
              emitChunk(new TextEncoder().encode(text).buffer as ArrayBuffer); emitDone();
            }
          } catch (e) { emitError(e instanceof Error ? e : new Error(String(e))); }
        })();
      },
      cancel() { cancelled = true; },
      async close() { closed = true; chunkHandlers.clear(); doneHandlers.clear(); errorHandlers.clear(); },
      onAudioChunk(h: Handler<ArrayBuffer>) { chunkHandlers.add(h); return () => chunkHandlers.delete(h); },
      onDone(h: Handler<void>) { doneHandlers.add(h as any); return () => doneHandlers.delete(h as any); },
      onError(h: Handler<Error>) { errorHandlers.add(h); return () => errorHandlers.delete(h); },
    };
  }

  return {
    name: "elevenlabs",
    async connect(): Promise<TTSSession> {
      const isMock = !config.apiKey || config.apiKey === "mock";
      if (isMock) return createSession(true, null);
      // Lazy import of the optional peer dependency. Kept behind a variable so browser bundlers
      // don't try to resolve it statically when the app never calls elevenLabsTTS().
      const specifier = "elevenlabs";
      let mod: any = null;
      try { mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier); } catch {}
      if (!mod) throw new Error("ElevenLabs SDK not installed. Install with: npm i elevenlabs. Then set apiKey in elevenLabsTTS({ apiKey }).");
      const Client = mod.ElevenLabsClient ?? mod.ElevenLabs ?? mod.default?.ElevenLabsClient ?? mod.default;
      let client: any = null;
      try { client = Client ? new Client({ apiKey: config.apiKey }) : mod; } catch { client = mod; }
      return createSession(false, client);
    },
    async synthesize(text: string, opts?: TTSOptions): Promise<ArrayBuffer> {
      const chunks: ArrayBuffer[] = [];
      const sess = await createSession(!config.apiKey || config.apiKey === "mock", null);
      return new Promise((resolve, reject) => {
        sess.onAudioChunk((c) => chunks.push(c));
        sess.onDone(() => {
          const total = chunks.reduce((n, c) => n + c.byteLength, 0);
          const out = new Uint8Array(total); let off = 0;
          for (const c of chunks) { out.set(new Uint8Array(c), off); off += c.byteLength; }
          resolve(out.buffer);
        });
        sess.onError(reject);
        sess.synthesize(text, opts);
      });
    },
  };
}