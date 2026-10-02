export interface TTSOptions {
  voiceId?: string;
  format?: string;
  speed?: number;
  prosody?: {
    pitch?: string;
    rate?: string;
    volume?: string;
  };
}

export interface TTSSession {
  synthesize(text: string, options?: TTSOptions): void;
  cancel(): void;
  close(): Promise<void>;
  onAudioChunk(handler: (chunk: ArrayBuffer) => void): () => void;
  onDone(handler: () => void): () => void;
  onError(handler: (error: Error) => void): () => void;
}

export interface TTSProvider {
  name: string;
  connect(): Promise<TTSSession>;
  synthesize?(text: string, options?: TTSOptions): Promise<ArrayBuffer>;
}
