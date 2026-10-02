export interface STTResult {
  transcript: string;
  confidence: number;
  isFinal: boolean;
}

export interface STTStreamOptions {
  onResult: (result: STTResult) => void;
  onError?: (error: Error) => void;
}

export interface STTSession {
  sendAudio(chunk: ArrayBuffer): void;
  close(): Promise<void>;
}

export interface STTProvider {
  name: string;
  connect(options: STTStreamOptions): Promise<STTSession>;
  /** One-shot transcription for tests / non-streaming fallback */
  transcribe?(audio: ArrayBuffer): Promise<STTResult>;
}
