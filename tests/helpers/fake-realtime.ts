import type { VoiceAgentEvent, VoiceProvider, VoiceSession } from "samai-sdk/voice";

/**
 * A fake realtime provider standing in for `openaiRealtime()`.
 *
 * It exposes the same `VoiceSession` surface the real provider returns and lets a test drive the
 * conversation by emitting `VoiceAgentEvent`s, which is what makes the state machine, transcript,
 * interruption, reconnect, and cleanup behaviour testable without an OpenAI connection.
 */
export class FakeRealtimeProvider implements VoiceProvider {
  name = "fake-openai-realtime";
  /** One entry per `connect()` call, so reconnect counts are observable. */
  sessions: FakeRealtimeSession[] = [];
  connectOptions: Array<Record<string, unknown>> = [];

  /** Set to make the next `connect()` reject. */
  failNextConnect: Error | null = null;
  /** Set to make every connect after this one reject (for exhaustion tests). */
  failAllConnects: Error | null = null;

  async connect(options: { agent: unknown }): Promise<VoiceSession> {
    this.connectOptions.push(options.agent as Record<string, unknown>);
    if (this.failNextConnect) {
      const error = this.failNextConnect;
      this.failNextConnect = null;
      throw error;
    }
    if (this.failAllConnects) throw this.failAllConnects;

    const session = new FakeRealtimeSession();
    this.sessions.push(session);
    return session as unknown as VoiceSession;
  }

  get latest(): FakeRealtimeSession {
    const session = this.sessions[this.sessions.length - 1];
    if (!session) throw new Error("no session has been created yet");
    return session;
  }
}

export class FakeRealtimeSession {
  closed = false;
  interrupted = 0;
  sentText: string[] = [];
  private handlers = new Map<string, Set<(event: VoiceAgentEvent) => void>>();

  sendAudio() {}
  interrupt() {
    this.interrupted += 1;
  }
  async close() {
    this.closed = true;
    this.handlers.clear();
  }
  getConnectionState() {
    return this.closed ? "closed" : "connected";
  }
  getRemoteStream() {
    return null;
  }
  on(type: string, handler: (event: VoiceAgentEvent) => void) {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Emits an event to every subscriber, as the SDK's `runVoiceAgent` would. */
  emit(event: VoiceAgentEvent) {
    for (const handler of [...(this.handlers.get(event.type) ?? [])]) handler(event);
  }

  // ── convenience sequences ──────────────────────────────────────────────

  emitConnected() {
    this.emit({ type: "connection-state", state: "connected" });
  }

  /** Simulates the user starting to talk. `wasAssistantSpeaking` drives barge-in. */
  emitUserSpeechStarted(wasAssistantSpeaking = false) {
    if (wasAssistantSpeaking) this.emit({ type: "interruption", reason: "user-barge-in" });
    this.emit({ type: "user-speech-started" });
  }

  emitUserTurn(text: string) {
    this.emit({ type: "user-transcript-delta", delta: "" });
    for (const word of words(text)) this.emit({ type: "user-transcript-delta", delta: `${word} ` });
    this.emit({ type: "user-speech-ended", transcript: text, confidence: 1 });
  }

  emitAssistantSpeech(text: string) {
    this.emit({ type: "agent-speech-started" });
    for (const word of words(text)) this.emit({ type: "assistant-transcript-delta", delta: `${word} ` });
  }

  emitAssistantTurn(text: string) {
    this.emitAssistantSpeech(text);
    this.emit({ type: "assistant-transcript-done", transcript: text });
    this.emit({ type: "agent-speech-ended" });
  }
}

function words(text: string): string[] {
  return text.split(" ").filter(Boolean);
}

/**
 * Mocks the `openaiRealtime` export while leaving everything else in `samai-sdk/voice` real — the
 * tests exercise the real `runVoiceAgent` event plumbing and the real `ConversationEngine` inside
 * the fake provider's place.
 */
export function mockOpenAIRealtime() {
  const provider = new FakeRealtimeProvider();
  return { provider };
}