#!/usr/bin/env node
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";

interface ParsedArgs {
  command: string | undefined;
  target: string;
  provider: "anthropic" | "openai" | "groq" | "ollama";
  port: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  let target = "my-samai-agent";
  let provider: ParsedArgs["provider"] = "anthropic";
  let port = 4949;

  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--provider" || arg === "-p") {
      const val = rest[++i];
      if (val === "anthropic" || val === "openai" || val === "groq" || val === "ollama") provider = val;
    } else if (arg === "--port") {
      const val = Number(rest[++i]);
      if (Number.isInteger(val) && val > 0) port = val;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  if (positional[0]) target = positional[0];

  return { command, target, provider, port };
}

const PROVIDER_SNIPPETS: Record<ParsedArgs["provider"], { import: string; setup: string; envVar: string | null; model: string }> = {
  anthropic: {
    import: `import { anthropic } from "samai-sdk";`,
    setup: `anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`,
    envVar: "ANTHROPIC_API_KEY=your-key-here",
    model: "claude-sonnet-4-6",
  },
  openai: {
    import: `import { openai } from "samai-sdk";`,
    setup: `openai({ apiKey: process.env.OPENAI_API_KEY })`,
    envVar: "OPENAI_API_KEY=your-key-here",
    model: "gpt-4o",
  },
  groq: {
    import: `import { groq } from "samai-sdk";`,
    setup: `groq({ apiKey: process.env.GROQ_API_KEY })`,
    envVar: "GROQ_API_KEY=your-key-here",
    model: "llama-3.3-70b-versatile",
  },
  ollama: {
    import: `import { ollama } from "samai-sdk";`,
    setup: `ollama()`,
    envVar: null,
    model: "llama3.1",
  },
};

function packageJson(target: string): string {
  return JSON.stringify(
    {
      name: target,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        start: "tsx src/index.ts",
        dev: "tsx watch src/index.ts",
      },
      dependencies: {
        "samai-sdk": "^0.2.0",
      },
      devDependencies: {
        tsx: "^4.19.0",
        typescript: "^5.5.4",
      },
    },
    null,
    2
  );
}

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
    },
    include: ["src"],
  },
  null,
  2
);

function indexTs(provider: ParsedArgs["provider"]): string {
  const p = PROVIDER_SNIPPETS[provider];
  return `import { z } from "zod";
import { createClient, defineTool, defineAgent, runAgent } from "samai-sdk";
${p.import}

// A simple example tool — swap this out for whatever your agent actually needs to do.
const getWeather = defineTool({
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => \`It's sunny and 24°C in \${city}.\`,
});

const client = createClient({ provider: ${p.setup} });

const agent = defineAgent({
  name: "assistant",
  instructions: "You are a friendly, concise assistant. Use tools when they'd help answer the question.",
  model: "${p.model}",
  tools: [getWeather],
});

const result = await runAgent(client, agent, "What's the weather like in Tokyo?");

console.log(result.output);
console.log("\\n--- trace ---");
console.log(\`Model calls, tool calls, and timing are all in result.trace — try: console.log(result.trace)\`);
`;
}

function envExample(provider: ParsedArgs["provider"]): string {
  const p = PROVIDER_SNIPPETS[provider];
  if (!p.envVar) return "# No API key needed — this starter uses Ollama (local models).\n# Install Ollama from https://ollama.com, then: ollama pull llama3.1\n";
  return `${p.envVar}\n`;
}

function readmeMd(target: string, provider: ParsedArgs["provider"]): string {
  const p = PROVIDER_SNIPPETS[provider];
  const envStep = p.envVar ? `2. Copy \`.env.example\` to \`.env\` and add your API key\n3. ` : "2. ";
  return `# ${target}

A starter agent built with [samai-sdk](https://github.com/SamAI/samai-sdk).

## Run it

1. \`npm install\`
${envStep}\`npm start\`

## What's here

- \`src/index.ts\` — a single agent with one tool, ready to run
- Swap \`${p.model}\` for any model your provider supports
- Add more tools with \`defineTool()\`, more agents with \`defineAgent({ handoffs: [...] })\`

See the [full docs](https://github.com/SamAI/samai-sdk) for guardrails, sessions, structured output, streaming, retries/fallbacks, and tracing.
`;
}

const GITIGNORE = "node_modules\n.env\ndist\n*.log\n";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function runCreate(target: string, provider: ParsedArgs["provider"]): Promise<void> {
  const dir = join(process.cwd(), target);

  if (await pathExists(dir)) {
    console.error(`✖ "${target}" already exists. Choose a different name or remove it first.`);
    process.exitCode = 1;
    return;
  }

  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), packageJson(target));
  await writeFile(join(dir, "tsconfig.json"), TSCONFIG);
  await writeFile(join(dir, "src", "index.ts"), indexTs(provider));
  await writeFile(join(dir, ".env.example"), envExample(provider));
  await writeFile(join(dir, ".gitignore"), GITIGNORE);
  await writeFile(join(dir, "README.md"), readmeMd(target, provider));

  console.log(`✅ Created ${target}/\n`);
  console.log(`   cd ${target}`);
  console.log(`   npm install`);
  if (PROVIDER_SNIPPETS[provider].envVar) {
    console.log(`   cp .env.example .env   # then add your API key`);
  }
  console.log(`   npm start\n`);
}

function printHelp(): void {
  console.log(`samai-sdk CLI

Usage:
  npx samai-sdk create <directory> [--provider anthropic|openai|groq|ollama]
  npx samai-sdk trace <trace-file.json> [--port 4949]

Examples:
  npx samai-sdk create my-agent
  npx samai-sdk create support-bot --provider groq
  npx samai-sdk trace ./my-run-trace.json
`);
}

async function runTrace(traceFilePath: string, port: number): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(process.cwd(), traceFilePath), "utf-8");
  } catch (err) {
    console.error(`✖ Could not read "${traceFilePath}": ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`✖ "${traceFilePath}" is not valid JSON.`);
    process.exitCode = 1;
    return;
  }

  // Accept either a raw RunTrace, or a full RunResult (which has `.trace` on it) — whichever
  // someone happens to have `JSON.stringify()`'d and saved to disk.
  const trace = (parsed as any)?.trace && (parsed as any)?.runId === undefined ? (parsed as any).trace : parsed;

  if (!trace || typeof trace !== "object" || !("runId" in trace) || !("events" in trace)) {
    console.error(`✖ "${traceFilePath}" doesn't look like a RunTrace (or a RunResult containing one).`);
    process.exitCode = 1;
    return;
  }

  const { renderTraceHTML } = await import("./trace-viewer.js");
  const html = renderTraceHTML(trace as any);

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });

  console.log(`✅ Trace viewer running at http://localhost:${port}`);
  console.log(`   (${(trace as any).events.length} events, run "${(trace as any).runId}")`);
  console.log(`   Press Ctrl+C to stop.\n`);
}

async function main() {
  const { command, target, provider, port } = parseArgs(process.argv.slice(2));

  if (command === "create") {
    await runCreate(target, provider);
    return;
  }

  if (command === "trace") {
    await runTrace(target, port);
    return;
  }

  printHelp();
  if (command && command !== "help" && command !== "--help" && command !== "-h") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("✖", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
