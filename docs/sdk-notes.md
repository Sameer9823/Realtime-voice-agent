# Notes for the SDK maintainer

Two things this app needs that `samai-sdk@0.3.6` cannot currently express. Neither has been worked
around, per the project rule that SDK gaps get written down instead of engineered around.

---

## 1. Replay conversation history on reconnect

**What the app needs**

When a realtime connection drops and the app reconnects, it mints a fresh ephemeral credential and
re-establishes the session. The model arrives with no memory of the conversation, so after any
network blip the assistant behaves as though the user never spoke — the most recent few turns
visibly vanish.

The fix is to re-send the recent turns as `conversation.item.create` events once the new session is
up. Roughly the last 10 turns, capped by character count as well as count.

**Why the existing API cannot do this**

`VoiceSession` exposes:

```ts
interface VoiceSession {
  sendAudio(chunk: ArrayBuffer): void;
  interrupt(): void;
  close(): Promise<void>;
  on<E extends VoiceAgentEvent["type"]>(type: E, handler: ...): () => void;
  sendText?(text: string): void;
  getConnectionState?(): VoiceConnectionState;
  getRemoteStream?(): MediaStream | null;
}
```

There is no way to send an arbitrary realtime event.

`sendText()` is the closest thing, and it is the wrong tool: it starts a *new user turn* and waits
for a response. Replaying history with it would make the assistant answer each replayed line
("Nice to meet you, Priya." → "What is your name?"), which is worse than losing the history.

**Server-side alternatives, both checked and rejected**

- Attaching history to the ephemeral credential at mint time does not work. `session.conversation`
  is not a parameter OpenAI accepts:

  ```
  POST /v1/realtime/client_secrets
  → 400 Unknown parameter: 'session.conversation'. (param: session.conversation)
  ```

  Reproduce with `node scripts/probe-session-conversation.mjs` (needs `OPENAI_API_KEY`). Both an
  `input_text`/`audio` item shape and a `text` shape were tried.

**Suggested shape**

A narrow, transport-specific escape hatch, rather than exposing raw event injection to every caller:

```ts
interface VoiceSession {
  /**
   * Re-injects prior conversation turns without generating a response.
   * Only valid immediately after (re)connecting, before the first user turn.
   */
  replayHistory?(turns: Array<{ role: "user" | "assistant"; text: string }>): Promise<void>;
}
```

Optional, matching the existing `sendText?` convention, so providers that cannot honour it simply
leave it undefined and the app can fall back to a fresh session. Implementable on the OpenAI
realtime provider by emitting one `conversation.item.create` per turn with
`input_text` for user turns and `audio` for assistant turns, and should guard against the
`response.create` that a naive implementation might attach.

---

## 2. Confirming the transcription language hint is supported

Not a blocker — recorded so it is checked rather than assumed.

The session route sends `transcription: { model: "gpt-4o-transcribe", language: "hi" }` when the user
picks a specific language, and omits `language` for `auto`. Sending `"auto"` through would make
OpenAI look for a language literally named "auto", so omitting it is deliberate.

`gpt-4o-transcribe` accepting a BCP-47 `language` hint has **not** been verified against the live
API — only against mocked responses. Worth confirming that the parameter is accepted (and ignored
rather than rejected) before relying on it for low-resource languages such as Tamil, where the hint
carries the most weight.

A live check for this belongs alongside `scripts/live-realtime-check.mjs`.