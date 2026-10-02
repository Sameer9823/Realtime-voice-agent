// This module is Node-only by nature (it spawns real child processes via `node:child_process`,
// which has no equivalent in edge/Workers runtimes), unlike most of the rest of the SDK — so
// unlike `checkpoint.ts`/`session.ts`, which dynamically import `node:fs` to stay edge-compatible
// for the branches that don't need it, there's no such branch here worth preserving. Static
// imports are used throughout.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { mkdir, readFile as readFileAsync, readdir, rm, writeFile as writeFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export type SandboxLanguage = "javascript" | "python" | "bash";

export interface SandboxOptions {
  /**
   * Directory to use as the sandbox root. Default: a fresh temp directory under `os.tmpdir()`,
   * created immediately and removed on `close()`. Pass your own directory to root the sandbox
   * somewhere specific — in that case `close()` leaves it in place, since you own its lifecycle.
   */
  dir?: string;
  /** Max wall-clock time per `runCode()` call, in ms. Default: 30000. Overridable per call. */
  timeoutMs?: number;
  /** Max combined stdout+stderr bytes captured per execution before truncation. Default: 200000. */
  maxOutputBytes?: number;
  /**
   * Extra environment variables available to executed code, merged over a minimal safe base
   * (`PATH`, `HOME`, `TMPDIR`/`TMP`/`TEMP` only). The sandbox deliberately does **not** inherit
   * the rest of your process's environment — that's usually where API keys and other secrets
   * live, and code an agent decided to run is exactly the code you don't want reading them.
   */
  env?: Record<string, string>;
}

export interface SandboxRunOptions {
  language: SandboxLanguage;
  code: string;
  /** Overrides the sandbox's default `timeoutMs` for this one call. */
  timeoutMs?: number;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or `null` if the process was killed (e.g. due to timeout) or never started. */
  exitCode: number | null;
  timedOut: boolean;
  /** True if stdout or stderr hit `maxOutputBytes` and was cut off. */
  truncated: boolean;
}

export interface Sandbox {
  /** Absolute path to the sandbox's root directory on disk. Created synchronously before this object is returned. */
  readonly dir: string;
  /** Runs a snippet of code inside the sandbox directory (as its cwd) and returns captured output. */
  runCode(options: SandboxRunOptions): Promise<SandboxRunResult>;
  /** Writes a file relative to the sandbox root, creating parent directories as needed. Rejects if `relativePath` would resolve outside the sandbox root. */
  writeFile(relativePath: string, content: string): Promise<void>;
  /** Reads a file relative to the sandbox root. Rejects if `relativePath` would resolve outside the sandbox root. */
  readFile(relativePath: string): Promise<string>;
  /** Lists file paths (relative to the sandbox root) under `relativeDir`, recursively. Default: the whole sandbox root. */
  listFiles(relativeDir?: string): Promise<string[]>;
  /** Removes the sandbox's temp directory — a no-op if `dir` was supplied explicitly in `SandboxOptions`, since you own that directory's lifecycle in that case. */
  close(): Promise<void>;
}

/** Resolves `relativePath` against `root` and throws if the result would escape `root` (path traversal via "../", or an absolute/different-drive path). */
function resolveInside(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === "") return target; // relativePath resolves to the root itself
  const escapesUpward = rel.startsWith(`..${sep}`) || rel === "..";
  const isAbsoluteResult = resolve(rel) === rel; // e.g. a different drive letter on Windows
  if (escapesUpward || isAbsoluteResult) {
    throw new Error(
      `Path "${relativePath}" resolves outside the sandbox directory — sandbox file operations are confined to ${root}.`
    );
  }
  return target;
}

function safeEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...extra };
}

/** Runs `command`/`args` as a child process rooted at `cwd`, capturing stdout/stderr up to `maxOutputBytes` and enforcing `timeoutMs`. Never rejects — a missing interpreter or spawn failure comes back as a result with a message in `stderr`, same shape as any other failed run. */
function spawnAndCollect(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; maxOutputBytes: number }
): Promise<SandboxRunResult> {
  return new Promise<SandboxRunResult>((resolvePromise) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= opts.maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = opts.maxOutputBytes - stdoutBytes;
      if (chunk.length > remaining) {
        stdout += chunk.subarray(0, remaining).toString("utf-8");
        stdoutBytes = opts.maxOutputBytes;
        truncated = true;
      } else {
        stdout += chunk.toString("utf-8");
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= opts.maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = opts.maxOutputBytes - stderrBytes;
      if (chunk.length > remaining) {
        stderr += chunk.subarray(0, remaining).toString("utf-8");
        stderrBytes = opts.maxOutputBytes;
        truncated = true;
      } else {
        stderr += chunk.toString("utf-8");
        stderrBytes += chunk.length;
      }
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode, timedOut, truncated });
    };

    child.on("error", (err) => {
      // e.g. ENOENT — the interpreter isn't installed. Surface it as stderr rather than
      // rejecting, matching the shape of an actual failed run so callers only need one path.
      stderr += `${stderr ? "\n" : ""}Error: ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Creates an isolated working directory + code-execution environment for an agent to run
 * JavaScript, Python, or bash in, and to read/write files in as it works.
 *
 * What this actually isolates: a dedicated cwd (nothing an execution writes lands outside it —
 * `writeFile`/`readFile`/`listFiles` are also confined to it), a minimal environment (`PATH`,
 * `HOME`, `TMPDIR` only — your process's other env vars, including API keys, are not visible to
 * executed code), a wall-clock timeout, and an output size cap.
 *
 * What this does **not** do: provide OS-level isolation (no container, VM, or network
 * namespace) — executed code runs as a real child process on this machine with real filesystem
 * and network access to whatever `cwd` and the ambient network otherwise allow. Treat code
 * executed here the same as you'd treat code from an untrusted contributor's PR: fine for your
 * own experimentation and for models you trust with shell access, not a substitute for an actual
 * container/VM (Docker, gVisor, Firecracker, etc.) if you're running untrusted code or serving
 * multiple tenants. If you need that, run this SDK itself inside such a boundary and point `dir`
 * at a path within it — `createSandbox()` becomes the layer on top of that, not instead of it.
 *
 * Usage:
 *   const sandbox = createSandbox();
 *   await sandbox.writeFile("data.json", JSON.stringify({ n: 41 }));
 *   const result = await sandbox.runCode({
 *     language: "javascript",
 *     code: `
 *       import { readFileSync } from "node:fs";
 *       const { n } = JSON.parse(readFileSync("data.json", "utf-8"));
 *       console.log(n + 1);
 *     `,
 *   });
 *   console.log(result.stdout); // "42\n"
 *   await sandbox.close();
 */
export function createSandbox(options: SandboxOptions = {}): Sandbox {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 200_000;
  const env = safeEnv(options.env);
  const ownsDir = options.dir === undefined;

  const dir = options.dir
    ? (mkdirSync(options.dir, { recursive: true }), options.dir)
    : mkdtempSync(join(tmpdir(), "samai-sandbox-"));

  let runCounter = 0;

  return {
    dir,

    async runCode({ language, code, timeoutMs: perCallTimeoutMs }): Promise<SandboxRunResult> {
      const effectiveTimeout = perCallTimeoutMs ?? timeoutMs;
      runCounter += 1;

      if (language === "bash") {
        return spawnAndCollect("/bin/bash", ["-c", code], { cwd: dir, env, timeoutMs: effectiveTimeout, maxOutputBytes });
      }

      if (language === "javascript") {
        const scriptPath = join(dir, `.samai-run-${runCounter}.mjs`);
        await writeFileAsync(scriptPath, code, "utf-8");
        try {
          return await spawnAndCollect(process.execPath, [scriptPath], {
            cwd: dir,
            env,
            timeoutMs: effectiveTimeout,
            maxOutputBytes,
          });
        } finally {
          await rm(scriptPath, { force: true }).catch(() => {});
        }
      }

      // python
      const scriptPath = join(dir, `.samai-run-${runCounter}.py`);
      await writeFileAsync(scriptPath, code, "utf-8");
      try {
        return await spawnAndCollect("python3", [scriptPath], {
          cwd: dir,
          env,
          timeoutMs: effectiveTimeout,
          maxOutputBytes,
        });
      } finally {
        await rm(scriptPath, { force: true }).catch(() => {});
      }
    },

    async writeFile(relativePath, content) {
      const target = resolveInside(dir, relativePath);
      const parentDir = target.slice(0, -(target.split(sep).pop()?.length ?? 0)) || dir;
      await mkdir(parentDir, { recursive: true });
      await writeFileAsync(target, content, "utf-8");
    },

    async readFile(relativePath) {
      const target = resolveInside(dir, relativePath);
      return readFileAsync(target, "utf-8");
    },

    async listFiles(relativeDir = ".") {
      const start = resolveInside(dir, relativeDir);
      const out: string[] = [];
      async function walk(current: string): Promise<void> {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) await walk(full);
          else out.push(relative(dir, full));
        }
      }
      await walk(start);
      return out.sort();
    },

    async close() {
      if (!ownsDir) return; // caller supplied their own dir — don't delete it out from under them
      await rm(dir, { recursive: true, force: true }).catch(() => {
        // best-effort — fall back to the sync variant in case an async handle is still open
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* already gone, or genuinely can't be removed — nothing more we can do here */
        }
      });
    },
  };
}
