/**
 * Shows the intended real-world usage pattern for long-horizon coding-agent behavior: give the
 * model file + code-execution tools scoped to one sandbox, let it write code, run it, see the
 * output, and iterate. Requires a live ANTHROPIC_API_KEY — this isn't run in CI, it's
 * documentation you can copy from.
 *
 * Run with: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/sandbox-agent-usage.ts
 */
import { createClient, anthropic, defineAgent, runAgent, createSandbox, createSandboxTools } from "../src/index.js";

async function main() {
  const sandbox = createSandbox();
  const client = createClient({ provider: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) });

  const agent = defineAgent({
    name: "coder",
    instructions:
      "You write and test small scripts. You have execute_code, write_file, read_file, and " +
      "list_files tools, all scoped to the same sandbox directory. Write files with write_file, " +
      "then run them with execute_code — JavaScript runs as an ES module (use import, not " +
      "require). Show your work by running the code, not just describing it.",
    model: "claude-sonnet-4-6",
    tools: createSandboxTools(sandbox),
    maxTurns: 8,
  });

  const result = await runAgent(
    client,
    agent,
    "Write a fibonacci.py that prints the first 10 Fibonacci numbers, run it, and tell me the output."
  );

  console.log(result.text);
  console.log("\nFiles left in the sandbox:", await sandbox.listFiles());

  await sandbox.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
