/**
 * REAL (non-mocked) test for createSandbox()/createCodeExecutionTool()/createSandboxTools().
 *
 * Spawns actual `node`, `python3`, and `/bin/bash` child processes and does real filesystem
 * I/O against a real temp directory — no stubs. Verifies: JS/Python/bash execution and output
 * capture, timeout enforcement (a real process actually gets killed), output truncation, file
 * write/read/list, path-traversal rejection, env isolation (secrets in the parent process are
 * NOT visible to executed code), and the two tool-factory wrappers end to end.
 *
 * Run with: npx tsx examples/sandbox-usage-test.ts
 */
import { existsSync } from "node:fs";
import { createSandbox } from "../src/sandbox.js";
import { createCodeExecutionTool, createSandboxTools } from "../src/tools/code-execution.js";

let failures = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures++;
  }
}

async function testCore() {
  console.log("=== TEST: createSandbox() core ===");
  const sandbox = createSandbox({ maxOutputBytes: 50, timeoutMs: 5000 });
  console.log(`  sandbox dir: ${sandbox.dir}`);
  check("dir is available synchronously", typeof sandbox.dir === "string" && existsSync(sandbox.dir));

  const js = await sandbox.runCode({ language: "javascript", code: "console.log('hi from js', 1 + 1);" });
  console.log(`  js -> ${JSON.stringify(js)}`);
  check("javascript execution captures stdout", js.stdout.trim() === "hi from js 2");
  check("javascript execution exits 0", js.exitCode === 0);

  const py = await sandbox.runCode({ language: "python", code: "print('hi from python', 1 + 1)" });
  console.log(`  py -> ${JSON.stringify(py)}`);
  check("python execution captures stdout", py.stdout.trim() === "hi from python 2");

  const bash = await sandbox.runCode({ language: "bash", code: "echo hi from bash && pwd" });
  console.log(`  bash -> ${JSON.stringify(bash)}`);
  check("bash execution captures stdout", bash.stdout.includes("hi from bash"));
  check("bash cwd is the sandbox dir", bash.stdout.includes(sandbox.dir));

  const stderrCase = await sandbox.runCode({ language: "bash", code: "echo oops 1>&2; exit 3" });
  check("nonzero exit code is captured", stderrCase.exitCode === 3);
  check("stderr is captured", stderrCase.stderr.includes("oops"));

  // Timeout: a real sleep that actually gets killed.
  const start = Date.now();
  const timeout = await sandbox.runCode({ language: "bash", code: "sleep 10", timeoutMs: 500 });
  const elapsed = Date.now() - start;
  console.log(`  timeout case took ${elapsed}ms, result: ${JSON.stringify(timeout)}`);
  check("timeout is enforced (process killed well under 10s)", elapsed < 5000);
  check("timedOut flag is set", timeout.timedOut === true);

  // Truncation: maxOutputBytes was set to 50 above.
  const bigOutput = await sandbox.runCode({ language: "bash", code: "for i in $(seq 1 200); do echo line$i; done" });
  check("large output gets truncated", bigOutput.truncated === true);
  check("truncated output is capped near the byte limit", bigOutput.stdout.length < 500);

  // Files.
  await sandbox.writeFile("greeting.txt", "hello sandbox");
  check("readFile round-trips writeFile", (await sandbox.readFile("greeting.txt")) === "hello sandbox");

  await sandbox.writeFile("nested/dir/file.txt", "nested content");
  const files = await sandbox.listFiles();
  console.log(`  listFiles() -> ${JSON.stringify(files)}`);
  check("listFiles finds top-level file", files.includes("greeting.txt"));
  check("listFiles finds nested file", files.some((f) => f.endsWith("nested/dir/file.txt") || f.endsWith("nested\\dir\\file.txt")));
  check(
    "internal .samai-run-*.mjs/.py scratch files are cleaned up, not left cluttering listFiles()",
    !files.some((f) => f.startsWith(".samai-run-"))
  );

  // Code can read a file the API wrote.
  const readBack = await sandbox.runCode({
    language: "javascript",
    code: "import { readFileSync } from 'node:fs'; console.log(readFileSync('greeting.txt', 'utf-8'));",
  });
  console.log(`  readBack -> ${JSON.stringify(readBack)}`);
  check("executed code can read files written via writeFile()", readBack.stdout.trim() === "hello sandbox");

  // Path traversal protection.
  let traversalBlocked = false;
  try {
    await sandbox.readFile("../../etc/passwd");
  } catch {
    traversalBlocked = true;
  }
  check("path traversal ('../../etc/passwd') is rejected", traversalBlocked);

  let absoluteBlocked = false;
  try {
    await sandbox.writeFile("/tmp/should-not-write-here.txt", "nope");
  } catch {
    absoluteBlocked = true;
  }
  check("writing to an absolute path outside the sandbox is rejected", absoluteBlocked);

  // Env isolation: a secret in this test process's env should NOT reach executed code.
  process.env.SAMAI_TEST_SECRET = "super-secret-value";
  const envCheck = await sandbox.runCode({
    language: "bash",
    code: "echo \"secret=[$SAMAI_TEST_SECRET]\"",
  });
  console.log(`  env isolation check -> ${JSON.stringify(envCheck.stdout)}`);
  check("parent process env vars are NOT inherited by executed code", !envCheck.stdout.includes("super-secret-value"));
  delete process.env.SAMAI_TEST_SECRET;

  const dirBeforeClose = sandbox.dir;
  await sandbox.close();
  check("close() removes the auto-created temp directory", !existsSync(dirBeforeClose));
}

async function testExplicitDirNotDeleted() {
  console.log("=== TEST: explicit dir is not deleted by close() ===");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const myDir = mkdtempSync(join(tmpdir(), "samai-explicit-"));

  const sandbox = createSandbox({ dir: myDir });
  await sandbox.writeFile("marker.txt", "still here");
  await sandbox.close();
  check("explicit dir survives close()", existsSync(myDir) && existsSync(join(myDir, "marker.txt")));

  const { rm } = await import("node:fs/promises");
  await rm(myDir, { recursive: true, force: true });
}

async function testCodeExecutionTool() {
  console.log("=== TEST: createCodeExecutionTool() ===");
  const tool = createCodeExecutionTool({ languages: ["javascript", "python"] });
  check("tool is named execute_code", tool.name === "execute_code");

  const out = (await tool.execute({ language: "javascript", code: "console.log(21 * 2);" })) as string;
  console.log(`  execute_code output:\n${out}`);
  check("tool output includes stdout", out.includes("42"));
  check("tool output includes exit code line", out.includes("exit code: 0"));
}

async function testSandboxToolsBundle() {
  console.log("=== TEST: createSandboxTools() bundle ===");
  const sandbox = createSandbox();
  const tools = createSandboxTools(sandbox);
  const names = tools.map((t) => t.name);
  console.log(`  tools: ${names.join(", ")}`);
  check("bundle has all 4 tools", names.length === 4);
  check(
    "bundle includes execute_code, write_file, read_file, list_files",
    ["execute_code", "write_file", "read_file", "list_files"].every((n) => names.includes(n))
  );

  const writeFile = tools.find((t) => t.name === "write_file")!;
  const executeCode = tools.find((t) => t.name === "execute_code")!;
  const readFile = tools.find((t) => t.name === "read_file")!;
  const listFiles = tools.find((t) => t.name === "list_files")!;

  await writeFile.execute({ path: "script.py", content: "print(1 + 1)" });
  const runResult = (await executeCode.execute({ language: "python", code: "exec(open('script.py').read())" })) as string;
  console.log(`  cross-tool run result:\n${runResult}`);
  check("execute_code can run a file written by write_file", runResult.includes("2"));

  const content = await readFile.execute({ path: "script.py" });
  check("read_file returns what write_file wrote", content === "print(1 + 1)");

  const listing = (await listFiles.execute({})) as string;
  check("list_files lists the written file", listing.includes("script.py"));

  await sandbox.close();
}

async function main() {
  await testCore();
  await testExplicitDirNotDeleted();
  await testCodeExecutionTool();
  await testSandboxToolsBundle();

  console.log(failures === 0 ? "\n✅ All sandbox tests passed" : `\n❌ ${failures} sandbox test(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ Uncaught error:", err);
  process.exit(1);
});
