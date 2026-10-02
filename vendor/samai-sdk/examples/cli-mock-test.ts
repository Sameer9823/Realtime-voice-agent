import { execFileSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

console.log("=== TEST: `samai-sdk create` scaffolds a real, working project ===");

const repoRoot = process.cwd();
const workDir = join(repoRoot, "__cli_test_workspace");
const projectName = "test-agent";
const projectDir = join(workDir, projectName);

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

// Run the ACTUAL built CLI binary, the same way `npx samai-sdk create ...` would.
execFileSync("node", [join(repoRoot, "dist", "cli.js"), "create", projectName, "--provider", "groq"], {
  cwd: workDir,
  stdio: "pipe",
});

console.log(`  scaffolded project exists: ${existsSync(projectDir)}`);
if (!existsSync(projectDir)) throw new Error("CLI did not create the project directory");

const expectedFiles = ["package.json", "tsconfig.json", "src/index.ts", ".env.example", ".gitignore", "README.md"];
for (const file of expectedFiles) {
  const exists = existsSync(join(projectDir, file));
  console.log(`  ${file}: ${exists ? "present" : "MISSING"}`);
  if (!exists) throw new Error(`Expected scaffolded file missing: ${file}`);
}

const indexTs = readFileSync(join(projectDir, "src", "index.ts"), "utf8");
console.log(`  src/index.ts uses --provider groq: ${indexTs.includes('import { groq } from "samai-sdk"')}`);
if (!indexTs.includes('import { groq } from "samai-sdk"')) {
  throw new Error("--provider groq flag was not respected in the generated source");
}

const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
console.log(`  package.json name matches target dir: ${pkg.name === projectName}`);
if (pkg.name !== projectName) throw new Error("Scaffolded package.json name doesn't match the target directory");

// Re-running create against the same directory should fail loudly, not silently overwrite.
let refusedDuplicate = false;
try {
  execFileSync("node", [join(repoRoot, "dist", "cli.js"), "create", projectName], { cwd: workDir, stdio: "pipe" });
} catch {
  refusedDuplicate = true;
}
console.log(`  refuses to overwrite an existing directory: ${refusedDuplicate}`);
if (!refusedDuplicate) throw new Error("CLI should have refused to scaffold into an already-existing directory");

// Typecheck the scaffolded project's own source against the REAL built package — proves the
// generated code isn't just plausible-looking text, it's valid TypeScript against the actual
// published type surface (dist/index.d.ts), not a hand-wavy string template.
mkdirSync(join(projectDir, "node_modules"), { recursive: true });
symlinkSync(repoRoot, join(projectDir, "node_modules", "samai-sdk"));
symlinkSync(join(repoRoot, "node_modules", "zod"), join(projectDir, "node_modules", "zod"));

execFileSync(
  "node",
  [
    require.resolve("typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--skipLibCheck",
    join(projectDir, "src", "index.ts"),
  ],
  { cwd: projectDir, stdio: "pipe" }
);
console.log("  scaffolded src/index.ts typechecks cleanly against the real, built SDK types: true");

rmSync(workDir, { recursive: true, force: true });
console.log("✅ TEST passed\n");
console.log("🎉 CLI scaffolding test passed");
