/**
 * Browser-safe RFC 4122 v4 id generation.
 *
 * `node:crypto`'s `randomUUID` is unavailable in browser bundles, which previously made
 * `samai-sdk/voice` (which pulls in `voice-agent.ts`) fail to build for the client. `crypto.randomUUID`
 * exists in every supported runtime (Node 19+, all modern browsers, edge), with a `getRandomValues`
 * fallback for older hosts.
 */

const HEX = "0123456789abcdef";

export function randomUUID(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Version 4, RFC 4122 variant.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let out = "";
  for (let i = 0; i < 16; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += "-";
  }
  return out;
}
