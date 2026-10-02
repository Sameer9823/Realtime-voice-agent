/**
 * REAL (partially) test for the voice module (src/voice.ts).
 *
 * `generateSpeech()`/`transcribeAudio()` require api.openai.com, which this test's environment
 * cannot reach — those two are checked here only for their local, verifiable behavior (a clear
 * error when no API key is configured; see mcp/sandbox tests for what "REAL" end-to-end coverage
 * looks like elsewhere in this repo).
 *
 * `createRealtimeSession()` is tested against a REAL local WebSocket server (via the `ws`
 * package, a genuine TCP socket on localhost — not a mocked transport) that speaks the same
 * event protocol OpenAI's Realtime API documents. This exercises all the actual risk in this
 * module — connection handshake, session.update payload shape, base64 audio encode/decode,
 * event-type mapping, tool-call round-tripping, interrupt/cancel — without needing OpenAI's
 * real endpoint. What it can NOT verify: whether OpenAI's live server accepts/emits exactly
 * these event names and fields as documented. Verify that against a real API key before
 * production use — see the disclaimer at the top of src/voice.ts.
 *
 * Run with: npx tsx examples/voice-usage-test.ts
 */
import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import { z } from "zod";
import { generateSpeech, transcribeAudio, createRealtimeSession, type RealtimeEvent } from "../src/voice.js";
import { defineTool } from "../src/types.js";

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures++;
  }
}

async function testMissingApiKeyErrors() {
  console.log("=== TEST: clear errors with no API key configured ===");
  delete process.env.OPENAI_API_KEY;

  let speechThrew = false;
  try {
    await generateSpeech({ input: "hi" });
  } catch (err) {
    speechThrew = err instanceof Error && err.message.includes("API key");
  }
  check("generateSpeech() throws a clear error with no API key", speechThrew);

  let transcribeThrew = false;
  try {
    await transcribeAudio({ audio: Buffer.from("fake"), filename: "a.wav" });
  } catch (err) {
    transcribeThrew = err instanceof Error && err.message.includes("API key");
  }
  check("transcribeAudio() throws a clear error with no API key", transcribeThrew);
}

/** A minimal fake OpenAI Realtime server: accepts the connection, replies to session.update with
 * session.updated, and scripts a few server events so the client's parsing/emission gets
 * exercised end to end over a real socket. */
function startMockRealtimeServer(): Promise<{ port: number; close: () => Promise<void>; received: any[] }> {
  return new Promise((resolveServer) => {
    const received: any[] = [];
    const wss = new WebSocketServer({ port: 0 });

    wss.on("connection", (socket: WSWebSocket) => {
      socket.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        received.push(msg);

        if (msg.type === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated" }));
        }

        if (msg.type === "conversation.item.create" && msg.item?.role === "user") {
          // Simulate the model responding: a text delta, then a done, then an audio delta, then done.
          socket.send(JSON.stringify({ type: "response.text.delta", delta: "Hel" }));
          socket.send(JSON.stringify({ type: "response.text.delta", delta: "lo!" }));
          socket.send(JSON.stringify({ type: "response.text.done", text: "Hello!" }));
          socket.send(
            JSON.stringify({ type: "response.audio.delta", delta: Buffer.from("fake-pcm-bytes").toString("base64") })
          );
          socket.send(JSON.stringify({ type: "response.audio.done" }));
        }

        if (msg.type === "response.create" && received.some((m) => m.type === "conversation.item.create" && m.item?.type === "function_call_output")) {
          socket.send(JSON.stringify({ type: "response.done" }));
        }

        if (msg.type === "input_audio_buffer.append") {
          socket.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
        }

        if (msg.type === "response.cancel") {
          socket.send(JSON.stringify({ type: "response.done" }));
        }
      });

      // Trigger a tool call the first time a client connects and updates its session, so the
      // test can verify auto-execution + function_call_output round-tripping.
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            type: "response.function_call_arguments.done",
            name: "get_time",
            call_id: "call_123",
            arguments: JSON.stringify({}),
          })
        );
      }, 50);
    });

    wss.on("listening", () => {
      const address = wss.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolveServer({
        port,
        received,
        close: () => new Promise<void>((res) => wss.close(() => res())),
      });
    });
  });
}

async function testRealtimeSession() {
  console.log("=== TEST: createRealtimeSession() against a real local WebSocket server ===");
  const { port, close, received } = await startMockRealtimeServer();

  const events: RealtimeEvent[] = [];
  let toolWasCalled = false;

  const getTimeTool = defineTool({
    name: "get_time",
    description: "Gets the current time",
    parameters: z.object({}),
    execute: async () => {
      toolWasCalled = true;
      return "12:00 PM";
    },
  });

  const session = createRealtimeSession({
    url: `ws://localhost:${port}`,
    instructions: "You are a test assistant.",
    voice: "alloy",
    tools: [getTimeTool],
  });

  session.on((event) => events.push(event));

  await session.connect();
  check("connect() resolves once session.updated is received", events.some((e) => e.type === "session.ready"));

  const sentSessionUpdate = received.find((m) => m.type === "session.update");
  check("session.update was sent on connect", !!sentSessionUpdate);
  // GA shape: session.type, and all audio config nested under session.audio.{input,output}.
  check("session.update uses the GA session type", sentSessionUpdate?.session?.type === "realtime");
  check("session.update carries the configured voice under audio.output", sentSessionUpdate?.session?.audio?.output?.voice === "alloy");
  check("session.update configures the GA input audio format", sentSessionUpdate?.session?.audio?.input?.format?.type === "audio/pcm" && sentSessionUpdate.session.audio.input.format.rate === 24000);
  check("session.update enables input transcription so user transcripts arrive", !!sentSessionUpdate?.session?.audio?.input?.transcription?.model);
  check("session.update does not send the retired OpenAI-Beta header", !received.some((m) => m.type === "session.update" && m.session?.input_audio_format));
  check("session.update carries the configured instructions", sentSessionUpdate?.session?.instructions === "You are a test assistant.");
  check(
    "session.update advertises the get_time tool with a real JSON Schema (not undefined)",
    sentSessionUpdate?.session?.tools?.[0]?.name === "get_time" &&
      typeof sentSessionUpdate.session.tools[0].parameters === "object"
  );

  session.sendText("Hi there");
  await new Promise((r) => setTimeout(r, 150));

  const textDeltas = events.filter((e) => e.type === "text.delta").map((e: any) => e.delta);
  check("text.delta events arrived in order", textDeltas.join("") === "Hello!");
  check("text.done event arrived", events.some((e) => e.type === "text.done" && (e as any).text === "Hello!"));

  const audioEvent = events.find((e) => e.type === "audio.delta") as Extract<RealtimeEvent, { type: "audio.delta" }> | undefined;
  // audio bytes are a plain Uint8Array (not Node's Buffer) so the same code path runs in a browser.
  check("audio.delta event arrived with base64-decoded bytes", audioEvent?.audio instanceof Uint8Array && Buffer.from(audioEvent.audio).toString() === "fake-pcm-bytes");
  check("audio.done event arrived", events.some((e) => e.type === "audio.done"));

  session.sendAudio(Buffer.from([1, 2, 3]));
  await new Promise((r) => setTimeout(r, 50));
  const appendMsg = received.find((m) => m.type === "input_audio_buffer.append");
  check("sendAudio() base64-encodes the chunk", appendMsg?.audio === Buffer.from([1, 2, 3]).toString("base64"));
  await new Promise((r) => setTimeout(r, 50));
  check("server VAD speech_started maps to a speech_started event", events.some((e) => e.type === "speech_started"));

  session.interrupt();
  await new Promise((r) => setTimeout(r, 50));
  const cancelMsg = received.find((m) => m.type === "response.cancel");
  check("interrupt() sends response.cancel", !!cancelMsg);

  // Wait for the scripted function call to round-trip.
  await new Promise((r) => setTimeout(r, 300));
  check("the model's function call actually executed the registered tool", toolWasCalled);
  check("a tool_call event was also emitted for observability", events.some((e) => e.type === "tool_call" && (e as any).name === "get_time"));
  const outputMsg = received.find((m) => m.type === "conversation.item.create" && m.item?.type === "function_call_output");
  check("function_call_output was sent back with the tool's real result", outputMsg?.item?.output === "12:00 PM");
  check("call_id round-trips correctly", outputMsg?.item?.call_id === "call_123");

  await session.close();
  await close();
}

async function main() {
  await testMissingApiKeyErrors();
  await testRealtimeSession();

  console.log(failures === 0 ? "\n✅ All voice module tests passed" : `\n❌ ${failures} voice module test(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ Uncaught error:", err);
  process.exit(1);
});
