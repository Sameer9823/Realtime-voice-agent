# samai-sdk — pre-publish testing guide

Everything in this SDK has already been checked with:
- `npm run typecheck` → clean
- `npm run build` (tsup) → all 5 entry points (index, react, vue, svelte, cli) build clean
- `npm test` (28 mock-based example suites) → all pass

The `demo/` folder here adds a **real, unmocked** end-to-end check: an actual Node
backend using the built SDK against the live Anthropic API (+ Tavily for web search),
and an actual React frontend in your browser talking to it. Nothing in `demo/` is a
stub — every button hits a real network call.

## 1. Set up keys

```bash
cp .env.example .env
# edit .env — set ANTHROPIC_API_KEY *or* OPENAI_API_KEY (either works, auto-detected),
# and TAVILY_API_KEY (optional, enables web_search)
```

Get keys: Anthropic → console.anthropic.com, OpenAI → platform.openai.com,
Tavily → tavily.com (free tier, no card).

The demo server auto-selects a provider — Anthropic if `ANTHROPIC_API_KEY` is set,
otherwise OpenAI if `OPENAI_API_KEY` is set (model defaults: `claude-sonnet-4-6` /
`gpt-4o-mini`). Force one explicitly with `SAMAI_PROVIDER=openai` or `=anthropic` in `.env`.

## 2. Rebuild (only if you change source)

```bash
npm install
npm run build
```

`dist/` is already built and committed in this zip, so you can skip straight to step 3
if you haven't changed any source.

## 3. Run the real backend

```bash
cd demo/server
npm install
npm run dev
```

This starts a server on `http://localhost:8787` that:
- runs a real agent (`runAgentStream`) against `claude-sonnet-4-6`, with the real
  `web_search` tool wired in if `TAVILY_API_KEY` is set
- exposes `POST /api/extract`, a real `generateObject()` call validated against a
  Zod schema (structured output, with automatic repair retries)
- exposes `POST /api/websearch`, a direct call into `createWebSearchTool()` so you can
  sanity-check the Tavily integration on its own, outside the agent loop

## 4. Run the real frontend

In a second terminal:

```bash
cd demo/web
npm install
npm run dev
```

Open the printed URL (typically `http://localhost:5173`). You'll see three live panels:
1. **Chat** — streams real model output + a live tool-call/handoff activity feed
2. **Structured extraction** — real `generateObject` + Zod, shows the validated JSON
3. **Web search** — calls the real Tavily API directly

### Why the frontend doesn't import `samai-sdk` directly

`examples/react-usage.tsx` (and the `vue`/`svelte` equivalents) instantiate a
provider like `anthropic({ apiKey })` directly inside a component. **That will throw
at runtime in a real browser bundle** — the official `@anthropic-ai/sdk` (and most
provider SDKs) refuse to run client-side by default, since it means shipping your
secret API key to every visitor's browser:

```
AnthropicError: It looks like you're running in a browser-like environment.
This is disabled by default, as it risks exposing your secret API credentials...
```

I verified this directly against the installed `@anthropic-ai/sdk` — it's a hard
`throw`, not a warning. So as written, the `react.ts`/`vue.ts`/`svelte.ts` usage
examples describe a pattern that will fail for any consumer who copies them into an
actual client-side app. **This is worth fixing before publishing** — either:
- update the framework examples/docs to clarify `useAgent`/`client` must be
  constructed on the server (e.g. a Next.js Route Handler or RSC action) and the hook
  is for consuming a stream from there, not for holding a raw provider client-side; or
- add a documented `dangerouslyAllowBrowser`-style opt-in passthrough for people who
  understand the risk (e.g. local-only tools, Ollama), with a loud warning.

The `demo/` app here is built the way a real app should be: keys live in
`demo/server` only; `demo/web` never imports `samai-sdk` or sees a key, it just talks
HTTP/SSE to the server — which is exactly what the react-usage example is missing.

## 5. Things I verified vs. things you need to run yourself

I built and tested this from a sandboxed environment whose outbound network only
allows `api.anthropic.com` (plus package registries) — `api.openai.com` and
`api.tavily.com` are both blocked there with `host_not_allowed`. So:
- **Verified for real, by me, right here:** `npm run typecheck`, `npm run build`
  (all 5 entry points), `npm test` (28 mock suites), and both `demo/server` and
  `demo/web` typecheck + build clean.
- **Needs you to run it, with your own keys:** the actual live network calls —
  OpenAI chat, Tavily web search, and (if you use it) Anthropic chat. The code is
  correct by careful review and matches each provider's documented request/response
  shape, but I could not execute a live OpenAI or Tavily call myself from this sandbox.

Run the live check with:

```bash
npx tsx --env-file=.env examples/real-web-search-test.ts   # Tavily, standalone
```

and by clicking through the 3 panels in `demo/web` (step 3–4 below) with the backend
running against your real key.

## 6. Publish checklist

```bash
npm run typecheck   # already passing
npm run build       # already passing
npm test            # already passing (mock suite)
# after confirming the demo above works with your real keys:
npm pack --dry-run  # inspect exactly what will be published
npm login           # if not already
npm publish
```

`prepublishOnly` already runs `npm run build` automatically on `npm publish`, so the
build step above is really just for your own confirmation before that point.
