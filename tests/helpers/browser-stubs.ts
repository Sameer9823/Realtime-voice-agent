import { vi } from "vitest";

/**
 * Browser API stubs.
 *
 * jsdom implements neither WebRTC nor Web Audio, and has no `MediaStream`. These stubs are minimal
 * but behavioural: tracks really report `stop()`, analysers really fill their buffer, and contexts
 * really transition state — so cleanup assertions test the app's behaviour rather than a mock's
 * call log.
 */

export class FakeMediaStreamTrack {
  stopped = false;
  constructor(public kind: string = "audio") {}
  stop() {
    this.stopped = true;
  }
  get readyState() {
    return this.stopped ? "ended" : "live";
  }
}

export class FakeMediaStream {
  tracks: FakeMediaStreamTrack[] = [];
  constructor(tracks?: FakeMediaStreamTrack[]) {
    if (tracks) this.tracks = tracks;
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "running";
  closed = false;
  analysers: FakeAnalyser[] = [];
  sources: FakeMediaStreamSource[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createAnalyser() {
    const a = new FakeAnalyser();
    this.analysers.push(a);
    return a as unknown as AnalyserNode;
  }
  createMediaStreamSource() {
    const s = new FakeMediaStreamSource();
    this.sources.push(s);
    return s as unknown as MediaStreamAudioSourceNode;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
}

export class FakeAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  connected = true;
  /** Amplitude the stubbed microphone will report, 0–1. */
  amplitude = 0;
  getByteTimeDomainData(buffer: Uint8Array) {
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] = Math.round(128 + this.amplitude * 127 * Math.sin((i / buffer.length) * Math.PI * 2));
    }
  }
  disconnect() {
    this.connected = false;
  }
}

export class FakeMediaStreamSource {
  connected = true;
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}

/** Installs the stubs on globalThis. Returns a reset helper. */
export function installBrowserStubs(options: { micTracks?: number } = {}) {
  FakeAudioContext.instances = [];

  const g = globalThis as Record<string, unknown>;
  g.MediaStream = FakeMediaStream;
  g.AudioContext = FakeAudioContext;
  g.RTCPeerConnection = class {
    constructor() {}
  };

  // jsdom does not implement media playback. Stub it so the session can attach and release the
  // assistant's audio element without raising "Not implemented".
  const played: HTMLMediaElement[] = [];
  const paused: HTMLMediaElement[] = [];
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: function play(this: HTMLMediaElement) {
      played.push(this);
      return Promise.resolve();
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    writable: true,
    value: function pause(this: HTMLMediaElement) {
      paused.push(this);
    },
  });

  const tracks = Array.from({ length: options.micTracks ?? 1 }, () => new FakeMediaStreamTrack());
  const stream = new FakeMediaStream(tracks);

  const getUserMedia = vi.fn(async (_constraints?: MediaStreamConstraints) => stream as unknown as MediaStream);

  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: { getUserMedia },
  });

  return {
    getUserMedia,
    stream,
    tracks,
    contexts: FakeAudioContext.instances,
    played,
    paused,
  };
}

/** Makes `getUserMedia` reject the way browsers do when the user blocks the prompt. */
export function denyMicrophone() {
  const error = new Error("Permission denied");
  error.name = "NotAllowedError";
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: {
      getUserMedia: vi.fn(async (_constraints?: MediaStreamConstraints) => {
        throw error;
      }),
    },
  });
  return error;
}
/** Makes `getUserMedia` reject because there is no recording device. */
export function missingMicrophone() {
  const error = new Error("Requested device not found");
  error.name = "NotFoundError";
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: {
      getUserMedia: vi.fn(async (_constraints?: MediaStreamConstraints) => {
        throw error;
      }),
    },
  });
  return error;
}