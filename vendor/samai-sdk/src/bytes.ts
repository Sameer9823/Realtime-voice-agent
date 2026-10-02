/**
 * Environment-agnostic binary helpers.
 *
 * The Realtime/TTS/STT paths in this SDK previously used `Buffer`, which only exists in Node. That
 * made `samai-sdk/voice` unusable in a browser bundle (the built `voice` entry referenced `Buffer`
 * at runtime, so audio handling threw `Buffer is not defined` the moment it was used on the client).
 * Everything here works in Node, browsers, and edge runtimes: `Uint8Array`/`ArrayBuffer` are the
 * common denominator, and `Buffer` is used only as an optional fast path.
 */

/** Anything that can carry audio bytes. */
export type BinaryLike = ArrayBuffer | ArrayBufferView | Uint8Array;

/** Normalizes any binary-ish input to a standalone `ArrayBuffer` with no extra bytes attached. */
export function toArrayBuffer(input: BinaryLike): ArrayBuffer {
  if (input instanceof ArrayBuffer) return input;
  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  // Last-resort duck typing for exotic hosts that expose a byte-array-ish object.
  const view = input as unknown as ArrayBufferView;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/** Normalizes any binary-ish input to a `Uint8Array` view over exactly the bytes it owns. */
export function toUint8Array(input: BinaryLike): Uint8Array {
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(toArrayBuffer(input));
}

const BASE64_CHUNK = 0x8000;

/**
 * Base64-encodes bytes without `Buffer` or `btoa`-arity limits.
 * `btoa` throws on inputs above ~64 KiB in some engines, so large chunks are encoded piecewise.
 */
export function bytesToBase64(input: BinaryLike): string {
  const bytes = toUint8Array(input);
  // Node fast path: avoids the string-concatenation cost for large realtime audio frames.
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    const chunk = bytes.subarray(i, Math.min(i + BASE64_CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
}

/** Decodes base64 to bytes without `Buffer`. */
export function base64ToBytes(input: string): Uint8Array {
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    const buf = Buffer.from(input, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = typeof atob === "function" ? atob(input) : Buffer.from(input, "base64").toString("binary");
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
