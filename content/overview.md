# Realtime Voice Agent

A browser voice agent that talks to you in real time. It listens through the microphone, streams
audio straight to the model, and plays the reply back without a round trip through a text API.

## What it does

- Speaks with you over a live audio connection, so you can interrupt it mid-sentence.
- Looks things up on the web, reads the weather, and answers questions about this project.
- Remembers the conversation across a dropped connection.
- Lets you pick a persona and a voice, and switch language mid-conversation.

## Getting started

```bash
npm install
cp .env.example .env.local
$EDITOR .env.local
npm run dev
```

You need an OpenAI API key. The app mints a short-lived browser credential from it, so your key
never reaches the page.

## Configuration

Everything is optional except the API key. Web search is off until you add a Tavily key.

| Variable | Required | What it does |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | Mints the browser's ephemeral realtime credential |
| `OPENAI_REALTIME_MODEL` | no | Which realtime model to use. Defaults to `gpt-realtime` |
| `OPENAI_REALTIME_VOICE` | no | Which voice to start with. Defaults to `marin` |
| `TAVILY_API_KEY` | no | Enables the `web_search` tool |
| `ALLOWED_ORIGINS` | no | Comma-separated origins allowed to call the API |
| `RATE_LIMIT_MAX` | no | Requests per minute per client. Defaults to 20 |
| `GLOBAL_CAP_MAX` | no | Requests per hour across all clients. Defaults to 600 |

## Talking to it

Press start and allow microphone access. While it speaks you can just talk over it, and it will stop
and listen.

There is a text box if you would rather not speak, and a mute button if you need a moment. If it
goes quiet for a while it will end the session on its own.

## Privacy

Audio is streamed to OpenAI and is not stored. Transcripts stay in your browser unless you
explicitly download or copy them.