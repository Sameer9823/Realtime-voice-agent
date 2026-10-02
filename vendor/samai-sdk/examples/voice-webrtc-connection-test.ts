import { WebRTCVoiceTransport } from "../src/voice/transport/webrtc.js";
import { createOffer, handleAnswer, handleOffer, addIceCandidate } from "../src/voice/transport/webrtc-signaling.js";
import { createMockVoiceTransport } from "../src/voice/testing.js";

let failures = 0;
function check(label: string, cond: boolean, detail="") {
  if (cond) console.log(`  \u2705 ${label}${detail ? " \u2014 "+detail : ""}`);
  else { console.log(`  \u274c ${label}${detail ? " \u2014 "+detail : ""}`); failures++; }
}

console.log("=== TEST: WebRTCVoiceTransport mock mode (no RTCPeerConnection in Node) ===");
const transport = new WebRTCVoiceTransport();
check("isMockMode true in Node without wrtc", transport.isMockMode === true);
await transport.connect();
check("connect in mock mode does not throw", true);
let trackFired = false;
transport.on("track", () => { trackFired = true; });
transport.addAudioTrack({ kind: "audio", id: "mock-track" } as any);
check("addAudioTrack in mock mode fires track event", trackFired);
check("getMockTracks has 1", transport.getMockTracks().length === 1);
check("getPeerConnection null in mock", transport.getPeerConnection() === null);

let audioFired = false;
transport.on("audio", () => { audioFired = true; });
transport.simulateRemoteAudio(new ArrayBuffer(4));
check("simulateRemoteAudio fires audio", audioFired);

transport.close();
check("close clears handlers (no throw)", true);

console.log("\n=== TEST: createMockVoiceTransport (in-memory duplex) ===");
const mock = createMockVoiceTransport();
check("not closed initially", mock.isClosed() === false);
let got: ArrayBuffer | null = null;
const unsub = mock.onAudio((c) => { got = c; });
mock.simulateRemoteAudio(new ArrayBuffer(8));
check("onAudio fires on simulateRemoteAudio", got !== null && (got as ArrayBuffer).byteLength === 8);
unsub();
got = null;
mock.simulateRemoteAudio(new ArrayBuffer(8));
check("unsub stops delivery", got === null);
mock.sendAudio(new ArrayBuffer(4));
check("sendAudio records chunk", mock.getSentChunks().length === 1);
mock.close();
check("close marks isClosed", mock.isClosed() === true);

console.log("\n=== TEST: signaling helpers with fake peer ===");
function fakePC() {
  let local: any = null, remote: any = null;
  const cands: any[] = [];
  return {
    async createOffer() { return { type: "offer", sdp: "fake-offer" }; },
    async setLocalDescription(d:any) { local = d; },
    async setRemoteDescription(d:any) { remote = d; },
    async createAnswer() { return { type: "answer", sdp: "fake-answer" }; },
    async addIceCandidate(c:any) { cands.push(c); },
    _getLocal(){return local}, _getRemote(){return remote}, _cands: cands,
  };
}
const pc1: any = fakePC();
const offer = await createOffer(pc1);
check("createOffer returns offer", offer.type === "offer");
check("createOffer sets localDescription", pc1._getLocal()?.type === "offer");

const pc2: any = fakePC();
await handleAnswer(pc2, { type: "answer", sdp: "ans" });
check("handleAnswer sets remoteDescription", pc2._getRemote()?.type === "answer");

const pc3: any = fakePC();
const answer = await handleOffer(pc3, { type: "offer", sdp: "off" });
check("handleOffer returns answer", answer.type === "answer");

const pc4: any = fakePC();
await addIceCandidate(pc4, { candidate: "cand", sdpMid: "0" });
check("addIceCandidate adds candidate", pc4._cands.length === 1);
await addIceCandidate(pc4, null);
check("addIceCandidate null is no-op", pc4._cands.length === 1);

let threw = false;
try { await createOffer(null as any); } catch { threw = true; }
check("createOffer invalid pc throws", threw);

if (failures) { console.log(`\n\u274c ${failures} failure(s)`); process.exit(1); }
console.log("\n\uD83C\uDF89 voice-webrtc tests passed");
