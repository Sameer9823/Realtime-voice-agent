/// <reference lib="dom" />
/**
 * Transport-agnostic WebRTC signaling helpers.
 * Caller wires the signaling channel (WebSocket, etc.) and calls these.
 */

export async function createOffer(pc: any, options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
  if (!pc?.createOffer || !pc?.setLocalDescription) throw new Error("Invalid peer connection: missing createOffer/setLocalDescription");
  const offer = await pc.createOffer(options);
  await pc.setLocalDescription(offer);
  return offer;
}

export async function handleAnswer(pc: any, answer: RTCSessionDescriptionInit): Promise<void> {
  if (!pc?.setRemoteDescription) throw new Error("Invalid peer connection: missing setRemoteDescription");
  const desc = typeof RTCSessionDescription !== "undefined" ? new RTCSessionDescription(answer) : answer;
  await pc.setRemoteDescription(desc);
}

export async function handleOffer(pc: any, offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
  if (!pc?.setRemoteDescription || !pc?.createAnswer || !pc?.setLocalDescription)
    throw new Error("Invalid peer connection: missing setRemoteDescription/createAnswer/setLocalDescription");
  const desc = typeof RTCSessionDescription !== "undefined" ? new RTCSessionDescription(offer) : offer;
  await pc.setRemoteDescription(desc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return answer;
}

export async function addIceCandidate(pc: any, candidate: RTCIceCandidateInit | null | undefined): Promise<void> {
  if (!candidate) return;
  if (!pc?.addIceCandidate) throw new Error("Invalid peer connection: missing addIceCandidate");
  const ice = typeof RTCIceCandidate !== "undefined" ? new RTCIceCandidate(candidate) : candidate;
  await pc.addIceCandidate(ice as any);
}