import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // `samai-sdk` ships prebuilt ESM/CJS, so it needs no transpilation. It is included here so that a
  // source checkout resolves cleanly in both dev and build.
  transpilePackages: ["samai-sdk"],

  webpack: (config) => {
    // samai-sdk declares these as optional peer dependencies and only imports them lazily inside
    // the STT/TTS pipeline providers, which this app never uses. Resolving them statically would fail
    // the client build when they aren't installed, so stub them out. (`ws` is samai-sdk's Node-only
    // WebSocket fallback; the browser uses the global WebSocket.)
    config.resolve.fallback = {
      ...config.resolve.fallback,
      ws: false,
      "@deepgram/sdk": false,
      elevenlabs: false,
    };
    return config;
  },
};

export default nextConfig;