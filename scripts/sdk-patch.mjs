#!/usr/bin/env node
/**
 * Regenerates `patches/samai-sdk+0.3.5.patch`.
 *
 * Why this exists: `samai-sdk@0.3.5` ships a realtime client that still speaks OpenAI's retired
 * preview protocol and uses `Buffer`/`node:crypto`, so it cannot drive a browser realtime session.
 * Rather than forking the SDK into the app, the app depends on the published npm package and this
 * script regenerates the patch that carries the upstream fixes (authored in `vendor/samai-sdk`,
 * which is a plain clone of the upstream repository so the changes stay reviewable against it).
 *
 * Run after editing `vendor/samai-sdk/src`:  npm run sdk:patch
 *
 * Sourcemaps are excluded — they are debug-only and would multiply the patch size for no benefit.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VENDOR = join(ROOT, "vendor", "samai-sdk");
const PATCH_FILE = join(ROOT, "patches", "samai-sdk+0.3.5.patch");
const { version } = JSON.parse(readFileSync(join(VENDOR, "package.json"), "utf8"));

function run(cmd, args, opts = {}) {
  // On Windows `npm`/`npx` are .cmd shims that execFileSync can't spawn directly. `git`/`tar` are real
  // executables and must not get a `.cmd` suffix.
  const needsShim = process.platform === "win32" && /^(npm|npx|yarn|pnpm)$/.test(cmd);
  const binary = needsShim ? `${cmd}.cmd` : cmd;
  return execFileSync(binary, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...(needsShim ? { shell: true } : {}),
    stdio: ["ignore", "pipe", "inherit"],
    ...opts,
  });
}

console.log(`[sdk-patch] building patched SDK sources in vendor/samai-sdk (v${version})`);
// `vendor/` is kept as a source-only checkout (no committed `node_modules`, `dist`, or `docs`), so
// install its dev dependencies on demand. tsup is required to build.
if (!existsSync(join(VENDOR, "node_modules"))) {
  console.log("[sdk-patch] vendor dependencies missing, installing");
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: VENDOR });
}
run("npm", ["run", "build"], { cwd: VENDOR });

const work = mkdtempSync(join(tmpdir(), "samai-patch-"));
try {
  // Pristine published tarball — the `a/` side of the diff.
  console.log("[sdk-patch] fetching the pristine published tarball");
  run("npm", ["pack", `samai-sdk@${version}`, "--pack-destination", work]);
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("could not locate the packed tarball");
  run("tar", ["-xzf", join(work, tarball), "-C", work]);

  const a = join(work, "a", "node_modules", "samai-sdk");
  const b = join(work, "b", "node_modules", "samai-sdk");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  cpSync(join(work, "package", "dist"), join(a, "dist"), { recursive: true });
  cpSync(join(VENDOR, "dist"), join(b, "dist"), { recursive: true });

  for (const side of [a, b]) {
    for (const name of readdirSync(join(side, "dist"), { recursive: true })) {
      const file = join(side, "dist", name);
      if (statSync(file).isFile() && name.endsWith(".map")) rmSync(file);
    }
  }

  console.log("[sdk-patch] diffing pristine vs patched build");
  let diff = "";
  try {
    // Exit code 1 just means "there are differences".
    diff = run("git", ["diff", "--no-index", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "a", "b"], { cwd: work });
  } catch (err) {
    diff = err.stdout ?? "";
    if (!diff) throw err;
  }

  // git renders the diff paths as `<prefix>a/...` because the trees are themselves named a/ and b/.
  // Collapse the doubled prefix so patch-package sees the paths it expects.
  for (const [from, to] of [
    ["a/a/", "a/"],
    ["b/b/", "b/"],
    ["a/b/", "a/"],
    ["b/a/", "b/"],
  ]) {
    diff = diff.split(`${from}node_modules/`).join(`${to}node_modules/`);
  }

  mkdirSync(join(ROOT, "patches"), { recursive: true });
  writeFileSync(PATCH_FILE, diff, "utf8");

  if (!existsSync(PATCH_FILE)) throw new Error("patch was not written");
  const kb = (statSync(PATCH_FILE).size / 1024).toFixed(1);
  console.log(`[sdk-patch] wrote ${PATCH_FILE} (${kb} KB)`);
  console.log("[sdk-patch] verify with: npm run sdk:patch:verify");
} finally {
  rmSync(work, { recursive: true, force: true });
}