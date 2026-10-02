import { z } from "zod";
import { defineTool, type ToolDefinition } from "../types.js";
import { createSandbox, type Sandbox, type SandboxLanguage, type SandboxOptions, type SandboxRunResult } from "../sandbox.js";

export interface CodeExecutionToolOptions {
  /**
   * Reuse an existing `Sandbox` (e.g. one you also pass to `createSandboxTools()`, so the model
   * can write a file with one tool and then run code against it with another) instead of having
   * this tool create its own internally. If omitted, a fresh sandbox is created lazily on first
   * use and lives for as long as the returned tool does — you're responsible for calling
   * `.close()` on it yourself if you want cleanup; grab it via the tool's `.sandbox` property.
   */
  sandbox?: Sandbox;
  /** Passed to `createSandbox()` when `sandbox` isn't supplied. Ignored if `sandbox` is set. */
  sandboxOptions?: SandboxOptions;
  /** Which languages the tool advertises to the model and accepts. Default: all three (`["javascript", "python", "bash"]`). */
  languages?: SandboxLanguage[];
  /** Per-call timeout, in ms. Default: 30000 (or the sandbox's own default, if lower). */
  timeoutMs?: number;
  /** Require human approval before any code executes. Default: false — code execution can do real damage; consider `true` for anything running unattended against untrusted input. */
  requiresApproval?: boolean;
}

function formatResult(result: SandboxRunResult): string {
  const parts: string[] = [];
  parts.push(`exit code: ${result.exitCode ?? "(killed)"}${result.timedOut ? " (timed out)" : ""}`);
  if (result.stdout) parts.push(`stdout:\n${result.stdout}${result.truncated ? "\n...[output truncated]" : ""}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  return parts.join("\n\n");
}

/**
 * Creates a ready-to-use `execute_code` tool that runs model-written code in an isolated
 * sandbox directory and returns its stdout/stderr/exit code. See `createSandbox()` in
 * `sandbox.ts` for exactly what "isolated" does and doesn't mean here — worth reading before
 * using this with untrusted input.
 *
 * For an agent that also needs to read/write files the code can then use, prefer
 * `createSandboxTools()`, which bundles this with file tools against the same sandbox instance.
 *
 * Usage:
 *   const agent = defineAgent({
 *     name: "analyst",
 *     instructions: "Use execute_code to run calculations and verify your answers.",
 *     model: "claude-sonnet-4-6",
 *     tools: [createCodeExecutionTool()],
 *   });
 */
export function createCodeExecutionTool(
  options: CodeExecutionToolOptions = {}
): ToolDefinition<{ language: SandboxLanguage; code: string }, string> {
  const languages = options.languages ?? (["javascript", "python", "bash"] as SandboxLanguage[]);
  let sandbox = options.sandbox;

  return defineTool({
    name: "execute_code",
    description:
      `Executes code in an isolated sandbox and returns its stdout, stderr, and exit code. ` +
      `Supported languages: ${languages.join(", ")}. JavaScript runs as an ES module — use ` +
      `"import", not "require". Use this to run calculations, test a snippet, process data, or ` +
      `check your work — not for anything that needs to persist beyond this call unless you've ` +
      `also been given file tools against the same sandbox.`,
    parameters: z.object({
      language: z.enum(languages as [SandboxLanguage, ...SandboxLanguage[]]).describe("Which interpreter to run the code with"),
      code: z.string().min(1).describe("The full source code to execute"),
    }),
    timeoutMs: options.timeoutMs ?? 30_000,
    requiresApproval: options.requiresApproval ?? false,
    execute: async ({ language, code }) => {
      if (!sandbox) sandbox = createSandbox(options.sandboxOptions);
      const result = await sandbox.runCode({ language, code, timeoutMs: options.timeoutMs });
      return formatResult(result);
    },
  });
}

/**
 * Bundles four tools — `execute_code`, `write_file`, `read_file`, `list_files` — all scoped to
 * one `Sandbox`, so a model can write files and then run code that reads them (or vice versa)
 * across multiple tool calls within the same agent run. This is the primitive behind
 * "long-horizon" coding-agent behavior: inspect files, edit them, run something, check the
 * output, repeat.
 *
 * Creates its own sandbox via `createSandbox(sandboxOptions)` if you don't pass one in. Call
 * `sandbox.close()` yourself when the agent run is done, if you want the temp directory cleaned
 * up — these tools don't do that automatically, since the model may still need the files after
 * its last tool call (e.g. for you to read the results back out with `sandbox.readFile()`).
 *
 * Usage:
 *   const sandbox = createSandbox();
 *   const agent = defineAgent({
 *     name: "coder",
 *     instructions: "Write and test code in the sandbox using the tools you've been given.",
 *     model: "claude-sonnet-4-6",
 *     tools: createSandboxTools(sandbox),
 *   });
 *   await runAgent(client, agent, "Write a fibonacci.py that prints the first 10 Fibonacci numbers, then run it.");
 *   console.log(await sandbox.readFile("fibonacci.py"));
 *   await sandbox.close();
 */
export function createSandboxTools(
  sandboxOrOptions?: Sandbox | SandboxOptions,
  options: Omit<CodeExecutionToolOptions, "sandbox" | "sandboxOptions"> = {}
): ToolDefinition[] {
  const sandbox: Sandbox =
    sandboxOrOptions && "runCode" in sandboxOrOptions ? sandboxOrOptions : createSandbox(sandboxOrOptions);

  const executeCode = createCodeExecutionTool({ ...options, sandbox });

  const writeFile = defineTool({
    name: "write_file",
    description: "Writes a file inside the sandbox (creating parent directories as needed), overwriting it if it already exists.",
    parameters: z.object({
      path: z.string().min(1).describe("File path, relative to the sandbox root"),
      content: z.string().describe("The full file content to write"),
    }),
    requiresApproval: options.requiresApproval ?? false,
    execute: async ({ path, content }) => {
      await sandbox.writeFile(path, content);
      return `Wrote ${content.length} characters to ${path}`;
    },
  });

  const readFile = defineTool({
    name: "read_file",
    description: "Reads and returns the contents of a file inside the sandbox.",
    parameters: z.object({ path: z.string().min(1).describe("File path, relative to the sandbox root") }),
    execute: async ({ path }) => sandbox.readFile(path),
  });

  const listFiles = defineTool({
    name: "list_files",
    description: "Lists all files (recursively) under a directory inside the sandbox. Omit `path` to list everything.",
    parameters: z.object({ path: z.string().optional().describe("Directory to list, relative to the sandbox root. Default: the sandbox root.") }),
    execute: async ({ path }) => {
      const files = await sandbox.listFiles(path);
      return files.length > 0 ? files.join("\n") : "(no files)";
    },
  });

  return [executeCode, writeFile, readFile, listFiles];
}
