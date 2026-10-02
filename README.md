# Voice Agent

Browser voice agent built on `samai-sdk@0.3.5` and OpenAI's GA Realtime API. WebRTC is the primary
transport with a WebSocket fallback, so the browser receives model audio as a low-latency media stream
instead of decoding a stream of PCM chunks.

## Quick start

```bash
npm install          # installs the SDK and applies the realtime patch via postinstall
cp .env.example .env.local
$EDITOR .env.local   # set OPENAI_API_KEY
npm run dev          # http://localhost:3000
```

Click **Start conversation** and allow microphone access. No key means the UI loads but the session
route returns `auth_failed`.

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | yes | — | Server-side only. Mints the ephemeral client secret. |
| `OPENAI_REALTIME_MODEL` | no | `gpt-realtime` | Realtime model. |
| `OPENAI_REALTIME_VOICE` | no | `marin` | Assistant voice. |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Override for a proxy or gateway. |

**Never rename `OPENAI_API_KEY` to a `NEXT_PUBLIC_` variable.** Next.js inlines `NEXT_PUBLIC_*` into
the client bundle; unprefixed vars are stripped from client builds. See
[Security](#security-model) for how this was verified.

## How it works

1. `POST /api/realtime/session` mints an ephemeral client secret on the server and returns it with
   the resolved model and voice.
2. The browser opens a WebRTC connection to OpenAI, exchanging SDP through the SDK's signing helper.
   The data channel carries control events; audio flows over an `audio` media track.
3. If WebRTC is unavailable, the SDK falls back to a WebSocket transport with base64 PCM.
4. Streaming input transcripts and assistant transcripts drive the UI. Assistant captions come from
   `response.output_audio_transcript.delta`.
5. Tools are declared with `defineTool` and dispatched by the SDK's conversation engine.

### Output modality

GA accepts **exactly one** output modality — `["text"]` or `["audio"]`. Requesting both
(`["audio", "text"]`) fails session creation with a 400 `Invalid modalities`. This app requests
`["audio"]`, which costs nothing in captioning because the assistant transcript arrives as
`response.output_audio_transcript.delta`.

### Layout

```
app/api/realtime/session/route.ts  Server route: mints the ephemeral credential
lib/voice/config.ts                Client-safe settings (instructions, turn detection, defaults)
lib/voice/server-config.ts         Server-only settings; reads process.env
lib/voice/agent.ts                 Voice agent factory
lib/voice/tools.ts                 Tool definitions
lib/voice/use-voice-session.ts     React hook: lifecycle, media, reconnect, barge-in
components/voice/VoiceAgent.tsx    UI
```

## The SDK patch

`samai-sdk@0.3.5` predates OpenAI's move from the Realtime preview API to GA, so it cannot talk to
the current endpoints. Rather than vendoring a fork, the project depends on the published package and
applies a patch at install time.

`patches/samai-sdk+0.3.5.patch` is applied by `patch-package` in `postinstall`. It covers:

- GA event and session shapes, and the client-secrets minting endpoint.
- Removal of the retired `OpenAI-Beta` header and the preview model names.
- Browser-safe byte and UUID handling (no `node:` imports, no unguarded `Buffer`).
- WebRTC SDP, data-channel, and ICE handling, plus client-secret generation.
- WebSocket truncation, barge-in, and connection lifecycle handling.
- Input and assistant transcript events.
- Re-exports of `ConversationEngine`, `VoiceActivityDetector`, `InterruptionController`, the WebRTC
  transport, signaling helpers, and test doubles.

`vendor/samai-sdk/` is a source-only checkout of the upstream repository, used to author the patch
and to run the SDK's own suites. Only `src/`, `examples/`, and the manifests are kept — about 0.8 MB.
Its `node_modules`, `dist`, and `docs` are not kept; `npm run sdk:patch` reinstalls and rebuilds them
on demand. **It is not a runtime dependency** — the app only ever imports from `node_modules/samai-sdk`.

### Working on the patch

```bash
npm run sdk:patch          # build vendor source, pack it, diff against the published tarball
npm run sdk:patch:verify   # assert the patch contains the expected changes
```

Edit under `vendor/samai-sdk/src/`, then run `npm run sdk:patch`. Regenerate the patch after every
source change; `postinstall` applies only what is committed to `patches/`. The script installs the
vendor's own dev dependencies and rebuilds its `dist` if either is missing, so the checkout stays
source-only in version control.

If `sdk:patch:verify` fails, the patch has drifted from the source it was generated from.

## Importing the SDK from client code

Import from `samai-sdk/voice`, never from `samai-sdk`. The package root pulls in Node-only modules
(sandbox, session stores) and fails the client build with `Module not found: Can't resolve 'fs'`.

```ts
import { defineTool, createVoiceAgent } from "samai-sdk/voice";
```

## Validation

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest
npm run build        # next build
npm run sdk:patch:verify
npm run sdk:test:voice   # realtime wire format, transports, barge-in, turn taking
```

The SDK's own suites cover the realtime wire format and transport behaviour and are also runnable:

```bash
npm run sdk:test:voice   # realtime wire format, transports, barge-in, turn taking
npm run check:live       # needs OPENAI_API_KEY; talks to the real Realtime API
```

`sdk:test:voice` covers `voice-usage-test` (GA session and transcript events over a real socket),
`voice-realtime-mock-test`, `voice-webrtc-connection-test`, `voice-interruption-mock-test`,
`voice-turn-taking-mock-test`, and `voice-pipeline-mock-test`.

`check:live` mints a real client secret, opens a real WebSocket with it, replays the app's exact
session payload, and asserts a non-empty assistant transcript. It is the fastest way to confirm the
app's wire format still matches the live API after an SDK or API change.

## Security model

- The API key stays on the server. The browser only ever receives a short-lived ephemeral client
  secret, valid for ten minutes and re-minted on reconnect.
- `lib/voice/server-config.ts` is imported only by the route handler, keeping `process.env` reads out
  of the client import graph.
- Verified empirically: a canary key placed in `.env.local` appears in neither `.next/static`, the
  server chunks, nor the served HTML.

## Known limitations

- The WebSocket transport is verified end-to-end against the live API. The WebRTC path is covered by
  the SDK's `voice-webrtc-connection-test`, but has not been exercised in a real browser with a
  microphone.
- Tools run on the client. There is no approval gate or sandbox, so a tool must not perform
  destructive work unattended.
- WebRTC requires a secure context. `localhost` is treated as secure; any other host needs HTTPS.
- Reconnect mints a new client secret but does not replay conversation history.
- Deepgram and ElevenLabs are optional peer dependencies. They are loaded dynamically with bundler
  hints so they never enter the client build unless configured.
