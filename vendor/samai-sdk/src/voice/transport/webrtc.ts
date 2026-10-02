/// <reference lib="dom" />
type Handler = (data?: any) => void;

/**
 * Minimal WebRTC peer-connection holder: owns an `RTCPeerConnection`, wires the standard
 * lifecycle events, and lets callers add tracks. Provider-specific negotiation (for example
 * OpenAI's SDP offer/answer over `/realtime/calls`) lives in subclasses.
 */
export class WebRTCVoiceTransport {
  private pc: RTCPeerConnection | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private mockTracks: any[] = [];
  private isMock: boolean;
  private iceServers: RTCIceServer[];

  constructor(config: { iceServers?: RTCIceServer[] } = {}) {
    this.iceServers = config.iceServers ?? [];
    this.isMock = typeof (globalThis as any).RTCPeerConnection === "undefined";
  }

  protected emit(event: string, data?: any) {
    this.handlers.get(event)?.forEach((h) => { try { h(data); } catch {} });
  }

  on(event: string, handler: Handler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.isMock) return;
    if (this.pc) return;
    this.attachPeerConnection(new RTCPeerConnection({ iceServers: this.iceServers }));
  }

  /** The ICE servers this transport was configured with. */
  getIceServers(): RTCIceServer[] {
    return [...this.iceServers];
  }

  /**
   * Installs a peer connection and wires its lifecycle events. Subclasses use this to negotiate
   * with a specific provider and to reuse the standard `icecandidate`/`track`/`connectionstatechange`
   * events without re-implementing them.
   */
  protected attachPeerConnection(pc: RTCPeerConnection): RTCPeerConnection {
    pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => { if (e.candidate) this.emit("icecandidate", e.candidate); };
    pc.ontrack = (e: any) => this.emit("track", e);
    pc.onconnectionstatechange = () => this.emit("connectionstatechange", (pc as any)?.connectionState);
    this.pc = pc;
    return pc;
  }

  addAudioTrack(track: MediaStreamTrack | any): void {
    if (this.isMock) { this.mockTracks.push(track); this.emit("track", { track }); return; }
    if (!this.pc) throw new Error("WebRTCVoiceTransport not connected — call connect() first.");
    const stream = new MediaStream([track as MediaStreamTrack]);
    if ((this.pc as any).addTrack) (this.pc as any).addTrack(track, stream);
    else (this.pc as any).addStream?.(stream);
  }

  close(): void {
    if (this.isMock) { this.mockTracks = []; this.handlers.clear(); return; }
    try { this.pc?.close(); } catch {}
    this.pc = null;
    this.handlers.clear();
  }

  // test helpers
  simulateRemoteAudio(chunk: ArrayBuffer) { this.emit("audio", chunk); }
  getMockTracks(): any[] { return [...this.mockTracks]; }
  getPeerConnection(): RTCPeerConnection | null { return this.pc; }
  get isMockMode(): boolean { return this.isMock; }
}

/** Stops every track on a stream. Call this when ending a conversation to release the microphone. */
export function stopMediaStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch {}
  }
}
