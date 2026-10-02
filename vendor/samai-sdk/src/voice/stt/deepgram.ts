import type { STTProvider, STTSession, STTStreamOptions, STTResult } from "./types.js";

export function deepgramSTT(config: { apiKey?: string; model?: string } = {}): STTProvider {
  return {
    name: "deepgram",
    async connect(options: STTStreamOptions): Promise<STTSession & { simulateTranscript?: (transcript: string, isFinal?: boolean) => void }> {
      const isMock = !config.apiKey || config.apiKey === "mock";

      if (isMock) {
        let closed = false;
        const session: STTSession & { simulateTranscript: (t: string, f?: boolean) => void } = {
          sendAudio(_chunk: ArrayBuffer) { if (closed) return; },
          async close() { closed = true; },
          simulateTranscript(transcript: string, isFinal = true) {
            if (closed) return;
            options.onResult({ transcript, confidence: 1, isFinal });
          },
        };
        return session;
      }

      // Real path — lazy import of the optional peer dependency.
      // The specifier is held in a variable on purpose: a literal `import("...")` would be resolved
      // statically by browser bundlers, which fails the whole client build whenever this optional
      // package isn't installed, even though the app never calls deepgramSTT().
      const specifier = "@deepgram/sdk";
      let mod: any = null;
      try { mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier); } catch {}
      if (!mod) {
        throw new Error(
          "Deepgram SDK not installed. Install with: npm i @deepgram/sdk. " +
          "Then set apiKey in deepgramSTT({ apiKey })."
        );
      }

      const createClient = mod.createClient ?? mod.default?.createClient;
      const Deepgram = mod.Deepgram ?? mod.default?.Deepgram;
      let client: any;
      if (createClient) client = createClient(config.apiKey);
      else if (Deepgram) client = new Deepgram(config.apiKey);
      else client = mod.default ? new mod.default(config.apiKey) : null;
      if (!client) throw new Error("Deepgram SDK shape unrecognized — expected createClient or Deepgram export.");

      // Try to open streaming connection
      let live: any = null;
      try {
        const model = config.model ?? "nova-2";
        if (client.listen?.live) live = client.listen.live({ model, smart_format: true, interim_results: true });
        else if (client.transcription?.live) live = client.transcription.live({ model });
      } catch (e) { /* fall through to mock-like shim */ }

      if (!live || typeof live.send !== "function") {
        // SDK present but streaming not available — shim that still forwards via mock
        let closed = false;
        return {
          sendAudio(_c: ArrayBuffer) { if (closed) return; },
          async close() { closed = true; try { live?.finish?.(); } catch {} },
          simulateTranscript(t: string, f = true) { options.onResult({ transcript: t, confidence: 1, isFinal: f }); },
        } as any;
      }

      live.on?.("Results", (data: any) => {
        const alt = data?.channel?.alternatives?.[0] ?? data?.alternatives?.[0];
        if (!alt) return;
        const transcript: string = alt.transcript ?? "";
        if (!transcript) return;
        const isFinal = (data.is_final ?? data.isFinal ?? true) as boolean;
        const res: STTResult = { transcript, confidence: alt.confidence ?? 1, isFinal: !!isFinal };
        options.onResult(res);
      });
      live.on?.("error", (e: any) => options.onError?.(e instanceof Error ? e : new Error(String(e))));

      let closed = false;
      const session: STTSession & { simulateTranscript: (t: string, f?: boolean) => void } = {
        sendAudio(chunk: ArrayBuffer) {
          if (closed) return;
          try { live.send(Buffer ? Buffer.from(chunk) : chunk); } catch (e) { options.onError?.(e as Error); }
        },
        async close() {
          if (closed) return; closed = true;
          try { live.finish?.(); live.close?.(); } catch {}
        },
        simulateTranscript(transcript: string, isFinal = true) {
          options.onResult({ transcript, confidence: 1, isFinal });
        },
      };
      return session;
    },
    async transcribe(_audio: ArrayBuffer): Promise<STTResult> {
      throw new Error("Use connect() streaming for Deepgram; one-shot transcribe not implemented in this adapter.");
    },
  };
}
