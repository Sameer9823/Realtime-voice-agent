/// <reference lib="dom" />
import { WebRTCVoiceTransport } from "./webrtc.js";

/**
 * WebRTC transport for OpenAI's Realtime API.
 *
 * The Realtime API can act as a WebRTC peer, which is the recommended way to build a browser voice
 * agent: the browser hands its microphone track straight to the API and renders the returned remote
 * track on a speaker element. Compared with the WebSocket transport this avoids base64-encoding
 * every PCM frame in and out of JavaScript, which is both slower and higher latency.
 *
 * Audio *events* still travel over a data channel, so this transport exposes the same
 * send/receive event surface as the WebSocket transport.
 *
 * Flow (OpenAI's documented browser flow):
 *   1. Create a peer connection, add the caller's microphone track, open an event data channel.
 *   2. Create an SDP offer and POST it to `/v1/realtime/calls` with an ephemeral client secret.
 *   3. The API replies with an SDP answer; set it as the remote description.
 *
 * Authentication uses an **ephemeral client secret** (`ek_...`) from
 * `POST /v1/realtime/client_secrets`, so a long-lived API key never reaches the browser.
 */

export interface OpenAIWebRTCTransportOptions {
  /** Ephemeral client secret (`ek_...`) or an API key for server-side use. */
  clientSecret?: string;
  /**
   * Mint a credential at negotiation time, e.g. a fresh ephemeral secret on reconnect once the
   * previous one has expired. Takes precedence over `clientSecret`.
   */
  getEphemeralKey?: () => Promise<string>;
  /** Microphone (or other input) track stream. The caller owns and must stop it. */
  inputStream: MediaStream;
  /** Session config sent alongside the SDP offer. Merged over the API defaults. */
  session?: Record<string, unknown>;
  /** Defaults to OpenAI's global STUN; override for a self-hosted / proxied deployment. */
  iceServers?: RTCIceServer[];
  /** SDP offer endpoint. Default: OpenAI's `https://api.openai.com/v1/realtime/calls`. */
  callsUrl?: string;
  /** Extra headers for the SDP POST (e.g. `OpenAI-Safety-Identifier`). */
  headers?: Record<string, string>;
  /** How long to wait for ICE gathering before sending the offer, ms. Default 3000. */
  iceGatherTimeoutMs?: number;
  /** Overall connect timeout, ms. Default 20000. */
  connectTimeoutMs?: number;
  /** Custom `fetch`, for tests or proxies. */
  fetchImpl?: typeof fetch;
}

export interface NegotiatedRealtimeCall {
  /** The API's remote audio stream. Attach it to an `<audio>` element to hear the assistant. */
  remoteStream: MediaStream;
  /** Call id from the `Location` header, for attaching a server-side data channel later. */
  callId: string | null;
  /** The event data channel, for callers that want raw access. */
  dataChannel: RTCDataChannel;
}

const DEFAULT_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export class OpenAIRealtimeWebRTCTransport extends WebRTCVoiceTransport {
  private clientSecret: string | undefined;
  private getEphemeralKey: (() => Promise<string>) | undefined;
  private inputStream: MediaStream | null;
  private sessionConfig: Record<string, unknown>;
  private callsUrl: string;
  private headers: Record<string, string>;
  private iceGatherTimeoutMs: number;
  private connectTimeoutMs: number;
  private fetchImpl: typeof fetch;
  private detachers: Array<() => void> = [];

  private channel: RTCDataChannel | null = null;
  private remote: MediaStream | null = null;
  private callId: string | null = null;
  private negotiated = false;

  constructor(options: OpenAIWebRTCTransportOptions) {
    super({ iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS });
    this.clientSecret = options.clientSecret;
    this.getEphemeralKey = options.getEphemeralKey;
    this.inputStream = options.inputStream;
    this.sessionConfig = options.session ?? {};
    this.callsUrl = options.callsUrl ?? DEFAULT_CALLS_URL;
    this.headers = options.headers ?? {};
    this.iceGatherTimeoutMs = options.iceGatherTimeoutMs ?? 3000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20000;
    this.fetchImpl = options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  /**
   * Completes the full SDP handshake. Returns once the peer connection is established and the
   * event channel is open.
   */
  async negotiate(): Promise<NegotiatedRealtimeCall> {
    if (this.negotiated && this.channel) {
      return { remoteStream: this.requireRemoteStream(), callId: this.callId, dataChannel: this.channel };
    }
    if (typeof RTCPeerConnection === "undefined") {
      throw new Error("WebRTC is not available in this browser.");
    }

    const pc = (await this.connectPeerConnection()) as RTCPeerConnection;
    this.observePeerConnection(pc);

    const channel = pc.createDataChannel("oai-events");
    this.channel = channel;
    channel.addEventListener("message", (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      this.emit("event", parsed);
    });
    channel.addEventListener("error", (event: Event) => this.emit("error", (event as RTCErrorEvent).error ?? event));
    channel.addEventListener("close", () => this.emit("close"));

    if (this.inputStream) {
      for (const track of this.inputStream.getTracks()) {
        pc.addTrack(track, this.inputStream);
      }
    }

    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    // Non-trickle: the offer must carry all gathered candidates, so wait for gathering to finish
    // (or give up and send whatever we have — the API still accepts a partial offer).
    await this.waitForIceGathering(pc, this.iceGatherTimeoutMs);

    const local = pc.localDescription;
    if (!local?.sdp) throw new Error("Failed to produce a local SDP offer.");

    const remoteSdp = await this.postSdp(local.sdp, this.connectTimeoutMs);
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: remoteSdp }));

    await this.waitForChannelOpen(channel, this.connectTimeoutMs);

    this.negotiated = true;
    return { remoteStream: this.requireRemoteStream(), callId: this.callId, dataChannel: channel };
  }

  /** Satisfies the base transport contract; delegates to `negotiate()`. */
  async connect(): Promise<void> {
    await this.negotiate();
  }

  /** Sends a realtime client event as JSON over the data channel. */
  send(event: Record<string, unknown>): void {
    if (!this.channel || this.channel.readyState !== "open") {
      throw new Error("OpenAIRealtimeWebRTCTransport: data channel is not open. Call negotiate() first.");
    }
    this.channel.send(JSON.stringify(event));
  }

  /** Like `send`, but never throws — used from teardown and interruption paths. */
  sendQuiet(event: Record<string, unknown>): void {
    try {
      this.send(event);
    } catch {
      /* channel already gone */
    }
  }

  getDataChannel(): RTCDataChannel | null {
    return this.channel;
  }

  getRemoteStream(): MediaStream | null {
    return this.remote;
  }

  getCallId(): string | null {
    return this.callId;
  }

  isNegotiated(): boolean {
    return this.negotiated;
  }

  close(): void {
    this.negotiated = false;
    this.callId = null;
    for (const detach of this.detachers) {
      try { detach(); } catch {}
    }
    this.detachers = [];
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
    this.remote = null;
    super.close();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async connectPeerConnection(): Promise<RTCPeerConnection> {
    if (typeof RTCPeerConnection === "undefined") {
      throw new Error("WebRTC is not available in this browser.");
    }
    const existing = this.getPeerConnection();
    if (existing) return existing;
    await super.connect();
    const pc = this.getPeerConnection();
    if (!pc) throw new Error("Failed to create an RTCPeerConnection.");
    return pc;
  }

  /**
   * The base class already wires `icecandidate`/`track`/`connectionstatechange`; this layers on the
   * bits the realtime call specifically needs — remembering the remote stream so the caller can play
   * it, and surfacing transport failures as `error` so reconnect logic can react.
   */
  private observePeerConnection(pc: RTCPeerConnection): void {
    const onTrack = this.on("track", (event: any) => {
      const stream: MediaStream | undefined = event?.streams?.[0];
      const track: MediaStreamTrack | undefined = event?.track;
      if (stream) this.remote = stream;
      else if (track) this.remote = new MediaStream([track]);
    });
    const onState = this.on("connectionstatechange", (state: unknown) => {
      if (state === "failed" || state === "disconnected") {
        this.emit("error", new Error(`Realtime WebRTC connection ${String(state)}.`));
      }
    });
    const onIce = () => {
      if (pc.iceConnectionState === "failed") this.emit("error", new Error("Realtime WebRTC ICE negotiation failed."));
    };
    pc.addEventListener("iceconnectionstatechange", onIce);
    this.detachers.push(onTrack, onState, () => pc.removeEventListener("iceconnectionstatechange", onIce));
  }

  private async postSdp(sdp: string, timeoutMs: number): Promise<string> {
    const credential = this.getEphemeralKey ? await this.getEphemeralKey() : this.clientSecret;
    if (!credential) {
      throw new Error(
        "OpenAIRealtimeWebRTCTransport has no credential. Pass { clientSecret } or { getEphemeralKey } — " +
          "mint an ephemeral secret server-side rather than exposing a long-lived API key."
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.callsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/sdp",
          ...this.headers,
        },
        body: sdp,
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Realtime SDP negotiation failed (${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}).`);
      }
      this.callId = res.headers.get("Location")?.split("/").pop() ?? null;
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === "complete") finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      pc.addEventListener("icegatheringstatechange", onChange);
    });
  }

  private waitForChannelOpen(channel: RTCDataChannel, timeoutMs: number): Promise<void> {
    if (channel.readyState === "open") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        channel.removeEventListener("open", onOpen);
        channel.removeEventListener("error", onError);
        fn();
      };
      const onOpen = () => finish(resolve);
      const onError = (event: Event) =>
        finish(() => reject(new Error(`Realtime data channel failed to open: ${(event as RTCErrorEvent).error?.message ?? "unknown error"}`)));
      const timer = setTimeout(
        () => finish(() => reject(new Error(`Realtime data channel did not open within ${timeoutMs}ms.`))),
        timeoutMs
      );
      channel.addEventListener("open", onOpen);
      channel.addEventListener("error", onError);
    });
  }

  private requireRemoteStream(): MediaStream {
    if (!this.remote) throw new Error("Realtime WebRTC call has no remote audio stream yet.");
    return this.remote;
  }
}

/**
 * Mints an ephemeral realtime client secret from OpenAI. Server-side only: this is the call that
 * needs the long-lived `OPENAI_API_KEY`, and the `ek_...` value it returns is what a browser is
 * allowed to hold.
 */
export async function createRealtimeClientSecret(params: {
  apiKey: string;
  model?: string;
  session?: Record<string, unknown>;
  /** Client-secret lifetime in seconds. OpenAI accepts 10–7200, defaults to 600. */
  ttlSeconds?: number;
  /** Value for OpenAI's abuse-tracking header. */
  safetyIdentifier?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ value: string; expiresAt: number | null }> {
  const doFetch = params.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = params.baseUrl ?? "https://api.openai.com/v1";
  const body: Record<string, unknown> = {};
  if (params.ttlSeconds !== undefined) body.expires_after = { anchor: "created_at", seconds: params.ttlSeconds };
  body.session = { type: "realtime", ...(params.model ? { model: params.model } : {}), ...(params.session ?? {}) };

  const res = await doFetch(`${base}/realtime/client_secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      ...(params.safetyIdentifier ? { "OpenAI-Safety-Identifier": params.safetyIdentifier } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Failed to create realtime client secret (${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}).`);
  }
  const data = (await res.json()) as { value?: string; expires_at?: number };
  if (!data.value) throw new Error("Realtime client secret response did not include a value.");
  return { value: data.value, expiresAt: typeof data.expires_at === "number" ? data.expires_at : null };
}
