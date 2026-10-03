# Troubleshooting

## The agent will not start

Check that `OPENAI_API_KEY` is set in `.env.local` and that the server was restarted after you
added it. The app reads the key at request time, so a restart is required.

If the page loads but starting a session fails immediately, the server cannot reach OpenAI. Check
the terminal running `npm run dev` for the exact upstream status.

## It cannot hear me

The browser asks for microphone permission the first time. If you dismissed it, the permission icon
usually sits at the left of the address bar; click it and allow the microphone, then reload.

On iOS, audio only starts after you tap the page once. Safari will not let a page play sound until
it has been interacted with.

Some browsers and operating systems mute a tab when it is not focused. If it works in one window and
not another, check that the other window actually has focus.

## The reply is choppy or the assistant talks over me

The app connects over WebRTC where it can and falls back to a WebSocket otherwise. WebSocket carries
audio as a stream of compressed chunks, so it is noticeably more sensitive to a poor connection than
WebRTC is. On a slow or lossy connection the WebSocket path will sound rougher; that is the
transport, not the app.

## The connection drops during a long conversation

Sessions are capped so a forgotten tab cannot hold a realtime connection open indefinitely. The app
warns before the limit and then ends cleanly. It mints a fresh credential and replays the recent
conversation, so you can carry on where you left off.

If it drops well before the limit, the network is dropping the WebRTC connection. This happens on
networks that block UDP; the fallback to WebSocket is automatic, though it will restart the audio
path.

## Web search says it is not available

That tool needs `TAVILY_API_KEY`. Without it the tool reports itself unavailable rather than failing
the turn, so the agent will say search is off and offer to answer another way.

## I want to change the voice

Pick one from the settings panel. The choices come from an allowlist in the code, so only voices
OpenAI actually supports are offered.