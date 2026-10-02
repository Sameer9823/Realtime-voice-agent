import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", react: "src/react.ts", vue: "src/vue.ts", svelte: "src/svelte.ts", cli: "src/cli.ts", "voice/index": "src/voice/index.ts", "voice/react": "src/voice/react/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  minify: false,
  target: "es2022",
  external: ["@deepgram/sdk", "elevenlabs", "react", "vue", "svelte", "svelte/store", "ioredis", "better-sqlite3", "neo4j-driver", "@aws-sdk/client-bedrock-runtime", "@opentelemetry/api", "@valibot/to-json-schema", "@modelcontextprotocol/sdk", "ws"],
});
