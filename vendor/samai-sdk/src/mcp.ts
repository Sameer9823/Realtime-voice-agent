import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export interface MCPStdioTransportConfig {
  /** Spawns a local process and speaks MCP over its stdin/stdout. The standard transport for local servers (filesystem, git, sqlite, etc). */
  transport: "stdio";
  /** The executable to run, e.g. "npx" or the path to a server binary. */
  command: string;
  /** Arguments passed to `command`, e.g. `["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]`. */
  args?: string[];
  /** Extra environment variables for the spawned process (merged with a safe default inherited set). */
  env?: Record<string, string>;
  /** Working directory for the spawned process. Defaults to the current process's cwd. */
  cwd?: string;
}

export interface MCPHttpTransportConfig {
  /** "http" is the current Streamable HTTP transport from the MCP spec (use this unless a server specifically requires SSE); "sse" is the legacy transport some older servers still expose. */
  transport: "http" | "sse";
  /** The server's MCP endpoint URL. */
  url: string;
  /** Extra headers sent with every request, e.g. `{ Authorization: \`Bearer ${token}\` }`. */
  headers?: Record<string, string>;
}

export type MCPTransportConfig = MCPStdioTransportConfig | MCPHttpTransportConfig;

export interface MCPClientOptions {
  /** Name this client reports to the server during the MCP `initialize` handshake. Default: "samai-sdk". */
  name?: string;
  /** Version this client reports to the server during the `initialize` handshake. Default: "1.0.0". */
  version?: string;
  /** How to connect: spawn a local process (stdio) or hit an HTTP endpoint (streamable HTTP or legacy SSE). */
  transport: MCPTransportConfig;
  /**
   * Prefixed onto every tool name pulled from this server, joined with "__" (e.g. "github" ->
   * "github__search_issues"), so multiple MCP servers wired into the same agent can't collide on
   * tool names. Default: none.
   */
  toolPrefix?: string;
  /** Per-call execution timeout, in ms, applied to every tool this client produces. Default: 30000. */
  timeoutMs?: number;
  /**
   * Require human approval before any tool from this server executes — passed straight through
   * to each resulting `ToolDefinition.requiresApproval`. Pass a predicate keyed on the MCP tool's
   * own (unprefixed) name to gate conditionally. Default: false.
   */
  requiresApproval?: boolean | ((toolName: string, args: Record<string, unknown>) => boolean | Promise<boolean>);
}

export interface MCPClient {
  /** Connects to the server if not already connected. `tools()` calls this automatically — most callers won't need to call it directly. */
  connect(): Promise<void>;
  /**
   * Lists the tools currently exposed by the server and converts each into a ready-to-use
   * samai-sdk `ToolDefinition`. Connects automatically on first call. Call again later (e.g.
   * after handling a `notifications/tools/list_changed` from the server) to pick up changes —
   * each call returns a fresh snapshot.
   */
  tools(): Promise<ToolDefinition[]>;
  /** Closes the underlying transport — kills the child process for stdio, closes the session for http/sse. Safe to call even if never connected. */
  close(): Promise<void>;
}

// Minimal structural types for what we actually read off the MCP SDK's Client/transports.
// Keeping these narrow (rather than importing the SDK's own types at the top level) means this
// file only ever touches `@modelcontextprotocol/sdk` inside the dynamic `import()`s below, so the
// rest of the SDK still builds and runs fine for consumers who don't have it installed.
interface RawMCPTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}
interface RawMCPContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  resource?: unknown;
}
interface RawMCPCallToolResult {
  content?: RawMCPContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}
interface RawMCPClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: RawMCPTool[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<RawMCPCallToolResult>;
  close(): Promise<void>;
}

async function createTransport(config: MCPTransportConfig): Promise<unknown> {
  try {
    if (config.transport === "stdio") {
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
      });
    }
    if (config.transport === "http") {
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    }
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    return new SSEClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  } catch (err) {
    throw new Error(
      `createMCPClient() requires the optional "@modelcontextprotocol/sdk" peer dependency. Install it with ` +
        `\`npm install @modelcontextprotocol/sdk\`. (Underlying error: ${err instanceof Error ? err.message : String(err)})`
    );
  }
}

/**
 * Flattens a `callTool` result's content blocks into the value handed back to the model. Prefers
 * `structuredContent` when the server provides it (typed JSON — easiest for the model, and your
 * own code, to consume); otherwise joins text blocks into a string and describes any non-text
 * blocks (images/audio/embedded resources) inline rather than dropping them silently.
 */
function flattenToolResult(result: RawMCPCallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;

  const blocks = result.content ?? [];
  if (blocks.length === 0) return "";
  if (blocks.every((b) => b.type === "text")) {
    return blocks.map((b) => b.text ?? "").join("\n");
  }
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text ?? "";
      if (b.type === "image" || b.type === "audio") return `[${b.type} content, mimeType: ${b.mimeType ?? "unknown"}]`;
      if (b.type === "resource") return `[embedded resource: ${JSON.stringify(b.resource)}]`;
      return `[${b.type} content]`;
    })
    .join("\n");
}

// Validation for an MCP tool's arguments before `execute()` runs is a permissive "is this an
// object" check rather than full JSON Schema validation against `inputSchema` — the MCP server
// itself validates the call against that schema, and the model sees the real schema (via
// `rawJsonSchema`, wired up below) when deciding what to send. Bringing in a JSON Schema
// validator here would just be checking the model's homework a second time with another
// dependency, for cases the server is already positioned to reject with a proper MCP error.
const passthroughObjectArgs = z.custom<Record<string, unknown>>(
  (val) => typeof val === "object" && val !== null,
  { message: "Tool arguments must be an object" }
);

/**
 * Connects to an MCP (Model Context Protocol) server and exposes its tools as samai-sdk
 * `ToolDefinition`s, ready to hand to `defineAgent()` or `generateText()`. Supports the
 * transports MCP servers commonly use today: a local stdio process, the current Streamable HTTP
 * transport, and the legacy SSE transport some older servers still expose.
 *
 * Requires the optional `@modelcontextprotocol/sdk` peer dependency
 * (`npm install @modelcontextprotocol/sdk`); it's imported dynamically so the rest of the SDK
 * works fine without it installed.
 *
 * Each MCP tool's own JSON Schema is sent to the model as-is (via `ToolDefinition.rawJsonSchema`)
 * rather than being round-tripped through zod, so nothing is lost in translation.
 *
 * Usage (local filesystem server over stdio):
 *   const fs = createMCPClient({
 *     transport: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
 *   });
 *   const agent = defineAgent({
 *     name: "assistant",
 *     instructions: "Help the user work with files in /tmp.",
 *     model: "claude-sonnet-4-6",
 *     tools: await fs.tools(),
 *   });
 *   // ...later, when you're done:
 *   await fs.close();
 *
 * Usage (remote server over Streamable HTTP, mixed with other tools):
 *   const acme = createMCPClient({
 *     transport: { transport: "http", url: "https://mcp.acme.com/mcp", headers: { Authorization: `Bearer ${token}` } },
 *     toolPrefix: "acme",
 *   });
 *   const tools = [...await acme.tools(), createWebSearchTool()];
 */
export function createMCPClient(options: MCPClientOptions): MCPClient {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let clientPromise: Promise<RawMCPClient> | null = null;

  async function connectInternal(): Promise<RawMCPClient> {
    type ClientConstructor = new (
      info: { name: string; version: string },
      opts?: { capabilities?: Record<string, unknown> }
    ) => RawMCPClient;
    let ClientCtor: ClientConstructor;
    try {
      const mod = await import("@modelcontextprotocol/sdk/client/index.js");
      ClientCtor = mod.Client as unknown as ClientConstructor;
    } catch (err) {
      throw new Error(
        `createMCPClient() requires the optional "@modelcontextprotocol/sdk" peer dependency. Install it with ` +
          `\`npm install @modelcontextprotocol/sdk\`. (Underlying error: ${err instanceof Error ? err.message : String(err)})`
      );
    }
    const transport = await createTransport(options.transport);
    const client = new ClientCtor(
      { name: options.name ?? "samai-sdk", version: options.version ?? "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    return client;
  }

  function getClient(): Promise<RawMCPClient> {
    if (!clientPromise) clientPromise = connectInternal();
    return clientPromise;
  }

  return {
    async connect() {
      await getClient();
    },

    async tools(): Promise<ToolDefinition[]> {
      const client = await getClient();
      const { tools } = await client.listTools();

      return tools.map((raw): ToolDefinition => {
        const publicName = options.toolPrefix ? `${options.toolPrefix}__${raw.name}` : raw.name;
        const requiresApproval =
          typeof options.requiresApproval === "function"
            ? (args: Record<string, unknown>) =>
                (options.requiresApproval as (n: string, a: Record<string, unknown>) => boolean | Promise<boolean>)(
                  raw.name,
                  args
                )
            : options.requiresApproval ?? false;

        return {
          name: publicName,
          description: raw.description ?? `MCP tool "${raw.name}"`,
          parameters: passthroughObjectArgs,
          rawJsonSchema: raw.inputSchema,
          timeoutMs,
          requiresApproval,
          execute: async (args: Record<string, unknown>) => {
            const result = await client.callTool({ name: raw.name, arguments: args ?? {} });
            if (result.isError) {
              const message = flattenToolResult(result);
              throw new Error(typeof message === "string" ? message : JSON.stringify(message));
            }
            return flattenToolResult(result);
          },
        };
      });
    },

    async close() {
      if (!clientPromise) return;
      const client = await clientPromise;
      await client.close();
    },
  };
}
