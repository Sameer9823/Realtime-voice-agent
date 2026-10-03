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

## 2. The transcription language hint — resolved

**Closed by measurement.** `scripts/probe-transcription-hint.mjs` mints a real ephemeral credential
for each transcription shape, which is the same call that would fail if the parameter were rejected.

| `transcription.language` | Result |
| --- | --- |
| omitted (what `auto` sends) | 200 accepted |
| `"hi"` (Hindi) | 200 accepted |
| `"ta"` (Tamil, the low-resource case worth caring about) | 200 accepted |
| `"en-US"` | **400 rejected** |
| `"auto"` | **400 rejected** |

So the parameter is accepted rather than ignored, and for the languages this app offers the hint
does something real.

Two constraints worth keeping in mind, both learned the hard way:

**Bare ISO-639-1 only.** `"en-US"` is rejected. OpenAI accepts `en`, not `en-US`, and answers with
the full list of 58 codes it will take. The `LANGUAGES` table in `lib/voice/personas.ts` already uses
bare codes, so nothing is broken today — but "upgrade the table to proper BCP-47 tags" is a
refactor that would break session creation for every language in it. `tests/personas.test.ts`
asserts every code the table offers is one OpenAI accepts, so that refactor now fails CI instead of
production.

**`"auto"` really is rejected**, which confirms that `transcriptionHint()` returning `{}` for the
auto case is correct rather than merely cautious. Passing it through would make OpenAI look for a
language literally named "auto".

Re-run the probe after any OpenAI model or API change:

```bash
OPENAI_API_KEY=... node scripts/probe-transcription-hint.mjs
```