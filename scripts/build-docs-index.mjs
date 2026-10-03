#!/usr/bin/env node
/**
 * Rebuilds content/index.json from the markdown files in /content.
 *
 * Run this after editing or adding anything in /content, otherwise `lookup_docs` keeps
 * answering from the previous snapshot:
 *
 *   npm run docs:index
 *
 * The output is committed on purpose. It is deterministic for a given set of markdown files,
 * so the diff shows exactly what changed in the documentation, and the tool works in a fresh
 * clone with no build step.
 *
 * If you ever swap the lexical vectors for neural embeddings, this is the only script that
 * needs to change — see lib/tools/docs-index.ts for why the trade was made this way.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIndex, readMarkdownDirectory } from "../lib/tools/docs-index.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CONTENT_DIR = join(ROOT, "content");
const OUTPUT = join(CONTENT_DIR, "index.json");

const files = readMarkdownDirectory(CONTENT_DIR);
if (files.length === 0) {
  console.error("[docs:index] no markdown files found in content/");
  process.exit(1);
}

const index = buildIndex(files);
writeFileSync(OUTPUT, `${JSON.stringify(index, null, 2)}\n`, "utf8");

const bytes = readFileSync(OUTPUT).length;
console.log(`[docs:index] indexed ${files.length} file(s) into ${index.chunks.length} chunks`);
console.log(`[docs:index] vocabulary of ${index.vocabulary.length} terms`);
console.log(`[docs:index] wrote ${OUTPUT} (${(bytes / 1024).toFixed(1)} KB)`);
console.log(`[docs:index] files: ${readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md")).join(", ")}`);