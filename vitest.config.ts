import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    server: {
      deps: {
        // `next-auth` is ESM and imports `next/server`, which Vite's own resolver will not resolve
        // because `next` publishes no exports map. Processing it in-process, with an explicit alias
        // below, keeps the real auth code under test instead of mocking it away.
        inline: [/@auth[\\/]core/, /next-auth/],
      },
    },
  },
  resolve: {
    alias: {
      "@": new URL("./", import.meta.url).pathname.replace(/\/$/, ""),
      "next/server": new URL("./node_modules/next/server.js", import.meta.url).pathname.replace(/\//g, "/"),
    },
  },
});