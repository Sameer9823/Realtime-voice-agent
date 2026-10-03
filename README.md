# Realtime Voice Agent

A live, interruptible voice conversation in the browser, on OpenAI's Realtime API. Audio flows over
WebRTC as a media stream, you can talk over the assistant mid-sentence, and the server-side tools it
can reach never expose their credentials to the page.

Built on [`samai-sdk`](https://www.npmjs.com/package/samai-sdk) for the realtime transport and
conversation engine, Next.js for the app, and Zod for every tool argument that crosses a boundary.

---

## Quick start

```bash
npm install
cp .env.example .env.local
# edit .env.local and set OPENAI_API_KEY
npm run dev            # http://localhost:3000
```

Click **Start conversation** and allow microphone access. Without a key the page still loads, but
`/api/realtime/session` answers `auth_failed` and the UI says so.

WebRTC needs a secure context. `localhost` counts as one; any other host needs HTTPS.

---

## Configuration

Only `OPENAI_API_KEY` is required. Everything else has a working default, and `.env.example`
documents every variable with its default.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | yes | — | Server-only. Mints the ephemeral client secret. |
| `OPENAI_REALTIME_MODEL` | no | `gpt-realtime` | Realtime model. |
| `OPENAI_REALTIME_VOICE` | no | `marin` | Assistant voice. |
| `OPENAI_BASE_URL` | no | OpenAI's | Override for a proxy or gateway. |
| `TAVILY_API_KEY` | no | — | Enables the web-search tool. |
| `REQUIRE_AUTH` | no | `false` | Require a signed-in user. See [Authentication](#authentication). |
| `AUTH_SECRET` | with auth | — | NextAuth session encryption key. `openssl rand -base64 32`. |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | no | — | GitHub OAuth, active when both are set. |
| `AUTH_EMAIL` / `AUTH_PASSWORD` | no | — | Shared password, active when both are set. |
| `RATE_LIMIT_MAX` | no | `20` | Per-client requests per window. |
| `RATE_LIMIT_WINDOW_MS` | no | `60000` | Per-client window. |
| `GLOBAL_CAP_MAX` | no | `600` | Deployment-wide cap per window. `0` disables it. |
| `GLOBAL_CAP_WINDOW_MS` | no | `3600000` | Global-cap window. |
| `ALLOWED_ORIGINS` | no | same-origin | Comma-separated origins allowed to call the API. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | no | — | Shared rate-limit store. See [Rate limiting](#rate-limiting). |
| `NEXT_PUBLIC_MAX_SESSION_MINUTES` | no | uncapped | Hard cap on one conversation. |
| `SENTRY_DSN` | no | — | Error reporting. Requires installing `@sentry/nextjs`. |

**Never rename `OPENAI_API_KEY` to a `NEXT_PUBLIC_` variable.** Next.js inlines `NEXT_PUBLIC_*` into
the client bundle at build time; unprefixed variables are stripped from client builds.

---

## How it works

1. `POST /api/realtime/session` mints an ephemeral OpenAI client secret on the server and returns it
   with the resolved model, voice, and fully composed system prompt.
2. The browser opens a WebRTC connection to OpenAI, exchanging SDP through the SDK's signing helper.
   Control events travel over the data channel; audio flows over an `audio` media track.
3. If WebRTC is unavailable, the SDK falls back to a WebSocket transport carrying base64 PCM.
4. The model calls a tool by name; the SDK posts to `/api/tools/<name>`, which validates the
   arguments with Zod and runs the implementation on the server.
5. Input and assistant transcripts stream in and drive the UI. Assistant captions come from
   `response.output_audio_transcript.delta`.
6. Token counts arrive on the SDK's `run-completed` event, are shown live in the development panel,
   and are posted to `/api/usage` when the conversation ends.

The system prompt is composed **on the server** and replayed verbatim by the client. That is what
stops a modified client from substituting its own instructions.

### Output modality

GA accepts exactly one output modality, `["text"]` or `["audio"]`; requesting both fails session
creation. This app requests `["audio"]`, which costs nothing in captioning because the assistant
transcript arrives as `response.output_audio_transcript.delta`.

---

## Tools

Three tools, all executed server-side. The model never holds a credential and cannot point a tool at
an arbitrary URL.

| Tool | What it does | Needs |
| --- | --- | --- |
| `web_search` | Tavily search, capped at 3 results with an 8-second timeout. | `TAVILY_API_KEY` |
| `get_weather` | Open-Meteo geocoding and forecast, in Fahrenheit, 6-second timeouts. | nothing |
| `lookup_docs` | Lexical TF-IDF search over `content/*.md`. | nothing |

`lookup_docs` is deliberately **not** semantic search. It is a lexical index with no embedding
provider, no vector store, and no per-query model call, so it has no API key to leak and no
embedding to get wrong. It answers "how do I configure X" well and "what is the thing that does Y"
poorly, and it is a couple of hundred lines instead of a dependency tree. Regenerate the index after
editing `content/`:

```bash
npm run docs:index
```

---

## Authentication

Off by default, because a demo you can clone and press Start on is the point. Set
`REQUIRE_AUTH=true` and every session requires a signed-in user.

```bash
REQUIRE_AUTH=true
AUTH_SECRET=$(openssl rand -base64 32)
AUTH_GITHUB_ID=...            # and AUTH_GITHUB_SECRET — the provider for real deployments
ALLOWED_ORIGINS=https://voice.example.com
```

GitHub OAuth activates when both its variables are set. A shared email and password activates as a
second provider when both of its variables are set, which is a convenience for testing the gate
without registering an OAuth app — it is a shared secret, not a user store.

Two layers, deliberately:

- `middleware.ts` checks for the presence of a session cookie and sends signed-out visitors to
  `/login`. This is user experience, not security.
- `checkAuth()` in every route handler verifies the session for real. This is the boundary.

The middleware stays lightweight on purpose: verifying a JWE on the Edge runtime would pull the whole
Auth crypto chain into its bundle for a check the handlers already make.

If `REQUIRE_AUTH=true` and no provider is configured, protected routes return **500**, not 200. A
deployment that asked for a login and quietly served everyone is the worst outcome, and an unusable
app is much easier to notice.

### Rate limiting

Per-client and global-cap limiters guard every public route. By default they are in-memory, which is
correct for a single Node process — the event loop serialises access to the map. It is wrong on two
or more instances, where each replica keeps its own counters and the effective limit multiplies by
the replica count. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (and
`npm install @upstash/redis`) to share them. Without the package the app falls back to in-memory
rather than failing.

Buckets are keyed by signed-in user id when there is one, and by IP otherwise. Without that, every
visitor behind a single NAT would share one allowance.

---

## Observability

`GET /api/health` reports liveness and whether each integration is configured — as booleans, never
values. It also reports whether `content/index.json` is present, because a missing docs index is the
one failure that surfaces as a mysteriously unhelpful assistant rather than an error.

`POST /api/usage` accepts a validated, bounded usage record and writes it to the server log. There is
no database; a single-instance deployment can support exactly this much honestly. It does not echo
the stored record back, so the endpoint cannot be used to probe what was logged.

A development-only panel shows the running tally — turns, tokens, reconnects, errors — and the
server's configuration. It renders `null` in a production build.

Sentry is optional and uninstalled. `lib/sentry.ts` is a no-op without `SENTRY_DSN` and loads
`@sentry/nextjs` through a variable specifier, so cloning this does not force a telemetry vendor on
anyone. Context is redacted in the bridge itself, not in the loader, so redaction cannot be bypassed
by whichever client is installed.

---

## Deployment

### Docker

```bash
docker build -t voice-agent .
docker run -p 3000:3000 -e OPENAI_API_KEY=sk-... voice-agent
```

Multi-stage: the runtime image carries the Next standalone server, its traced dependencies, the
static assets, and `content/` — not the source, not the full `node_modules`, and not the toolchain.
It runs as an unprivileged user and has a `HEALTHCHECK` against `/api/health`.

`NEXT_PUBLIC_MAX_SESSION_MINUTES` is a build argument, because `NEXT_PUBLIC_*` values are inlined
into the client bundle. Everything else is read at runtime.

### Anywhere else

Any host that runs Next.js 15 on Node 20+ works. `npm run build && npm start`.

Put it behind a reverse proxy that terminates TLS, and set `ALLOWED_ORIGINS` if the frontend and API
are served from different hosts. Set `REQUIRE_AUTH=true` and `AUTH_SECRET` before exposing it to
anyone you do not know.

---

## Validation

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest
npm run build        # next build
```

CI runs all four, then builds the image and smoke-tests `/api/health` in the container — the one
check that catches a broken Dockerfile, since a missing `public/` or `content/` copy only appears at
runtime.

`npm run check:live` talks to the real Realtime API and needs `OPENAI_API_KEY`. It mints a real
credential, opens a real connection, and asserts a non-empty assistant transcript. The rest of the
suite never needs a live credential: a test that only passes with a real key is a test that only ever
runs on one machine.

---

## Manual test steps

1. `npm run dev`, open `http://localhost:3000`, click **Start conversation**, and allow the
   microphone. The orb should settle into "Listening".
2. Say "what's the weather in Lisbon?" The status line should briefly read "using a tool", then the
   assistant should answer with a temperature. This exercises `/api/tools/get_weather` end to end.
3. Say "what is the base rate for a fictional product called the Widget 9000?" The assistant should
   search the web, or say plainly that search is unavailable when `TAVILY_API_KEY` is unset.
4. Start talking over the assistant mid-sentence. It should stop within a word or two and respond to
   what you just said. This is barge-in, and it is the thing that makes the app feel alive.
5. Open the "Session usage (dev only)" panel at the bottom. Turns and tokens should climb as you
   talk, then reset when you end the session. Compare the server log line against the session id.
6. Change the persona and language in the settings panel while stopped. Restart the conversation and
   confirm the assistant's manner and language changed.
7. With `REQUIRE_AUTH=true` and a provider configured, restart the dev server. `/` should redirect
   to `/login`; sign in and confirm the conversation screen loads.
8. Open the same page in a private window and confirm `/api/realtime/session` answers 401.

---

## Security model

- The OpenAI key stays on the server. The browser only ever receives a short-lived ephemeral client
  secret, valid for ten minutes and re-minted on reconnect.
- `lib/voice/server-config.ts` is imported only by route handlers, keeping `process.env` reads out
  of the client import graph.
- Every public route is origin-checked, rate-limited, and (when auth is on) session-verified.
- Tools run server-side behind a Zod schema, so a malformed or hostile model call cannot reach a tool
  implementation.
- Usage and error context is redacted by key name before anything is logged.
- Verified empirically: a canary key placed in `.env.local` appears in neither `.next/static`, the
  server chunks, nor the served HTML — including in the Docker image.

---

## Known limitations

- **Reconnect does not replay conversation history.** A dropped connection re-mints a fresh
  session, so the model arrives with no memory of what was said. `docs/sdk-notes.md` documents why,
  including the server-side alternatives that were tried and rejected. Replaying with `sendText()`
  was rejected because it makes the assistant answer each replayed line.
- **The WebSocket fallback is verified against the live API; the WebRTC path has not been exercised
  in a real browser with a microphone** in the course of writing this. `samai-sdk`'s
  `voice-webrtc-connection-test` covers it, and step 4 of the manual test above is the check worth
  running yourself.
- `next-auth` is a **beta** (`5.0.0-beta.32`). It is the release that supports the App Router on
  Next 15; the stable v4 line has a worse App Router and middleware story there. Worth revisiting
  when Auth.js goes stable.
- `lookup_docs` is lexical, so it matches words rather than meaning.
- The tools have no per-user isolation: any authorised caller can invoke any tool.

---

## Layout

```
app/api/realtime/session/route.ts  Mints the ephemeral credential; composes the system prompt
app/api/tools/[name]/route.ts       Server-side tool execution, guarded and schema-validated
app/api/usage/route.ts              Validated usage records, written to the log
app/api/health/route.ts             Liveness and configuration, booleans only
app/login/page.tsx                  Sign-in, using NextAuth server actions
middleware.ts                       Session-cookie presence check, for redirects only
lib/voice/use-voice-session.ts      The session hook: media, events, reconnect, teardown
lib/voice/guard.ts                  Origin, voice, model, and rate-limit guards
lib/auth.ts                         NextAuth config, provider wiring, auth decision
lib/tools/                          Server-side tool implementations and registry
lib/usage/                          Token accounting, redaction, reporting
components/voice/                   UI
content/                            Markdown the documentation tool indexes
scripts/                            Live API check, docs index builder
```

### Importing the SDK

Import from `samai-sdk/voice`, never from `samai-sdk`. The package root pulls in Node-only modules
and fails the client build.

```ts
import { defineTool, defineVoiceAgent } from "samai-sdk/voice";
```

---

## Licence

MIT. See [LICENSE](LICENSE).