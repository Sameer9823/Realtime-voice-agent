/**
 * A small lexical retrieval index over the markdown files in /content.
 *
 * Vectors are TF-IDF over a fixed vocabulary, not neural embeddings. That is a deliberate
 * trade: it needs no API key, no network, and no extra dependency, it is deterministic so
 * the index can be committed and diffed, and it is instant to rebuild. The cost is that it
 * matches words rather than meaning, so "how much does it cost" will not find a passage
 * headed "Pricing". For a handful of hand-written docs that is a reasonable bargain; if
 * the corpus grows past a few hundred chunks, swap `buildIndex`/`queryIndex` for OpenAI
 * embeddings and keep the same on-disk shape apart from the vector encoding.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/** One retrievable passage, with the heading path that gives it meaning in isolation. */
export interface DocChunk {
  id: string;
  docId: string;
  title: string;
  heading: string;
  text: string;
  /** Sparse TF-IDF vector keyed by vocabulary index. */
  vector: Record<string, number>;
}

export interface DocIndex {
  version: number;
  generatedAt: string;
  /** Ordered term list; the vector keys index into it. */
  vocabulary: string[];
  chunks: DocChunk[];
}

/** Words carrying no retrieval signal. Keeping this small keeps the vocabulary useful. */
const STOPWORDS = new Set([
  "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by",
  "can", "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it",
  "its", "me", "more", "most", "my", "no", "not", "of", "on", "one", "or", "our", "out", "so", "some",
  "such", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "up",
  "was", "we", "were", "what", "when", "which", "who", "will", "with", "would", "you", "your",
]);

/** Lowercases, strips punctuation, and drops stopwords. Keeps digits and CJK/Indic ranges. */
export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Splits markdown into heading-scoped paragraphs. A chunk never spans two `##` sections. */
export function chunkMarkdown(title: string, markdown: string, maxChars = 900): Array<{ heading: string; text: string }> {
  const lines = markdown.split("\n");
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } = { heading: title, lines: [] };

  for (const line of lines) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match) {
      sections.push(current);
      current = { heading: match[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const chunks: Array<{ heading: string; text: string }> = [];
  for (const section of sections) {
    const paragraphs = section.lines
      .join("\n")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !/^[-*]\s/.test(p));

    let buffer = "";
    for (const paragraph of paragraphs) {
      if (buffer.length + paragraph.length > maxChars && buffer.length > 0) {
        chunks.push({ heading: section.heading, text: buffer });
        buffer = "";
      }
      buffer = buffer ? `${buffer} ${paragraph}` : paragraph;
    }
    if (buffer) chunks.push({ heading: section.heading, text: buffer });
  }

  return chunks;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

/**
 * Builds a TF-IDF vector against a fixed vocabulary.
 *
 * Terms outside the vocabulary are dropped. That is what makes the vector stable across
 * rebuilds: the vocabulary is chosen once, from the corpus, and a new document can only
 * redistribute weight among known terms rather than shift every existing vector.
 */
export function buildVector(tokens: string[], vocabulary: string[]): Record<string, number> {
  const tf = termFrequency(tokens);
  const vector: Record<string, number> = {};
  for (const [term, count] of tf) {
    const index = vocabulary.indexOf(term);
    if (index === -1) continue;
    // Sub-linear term frequency so a word repeated ten times is not ten times the signal.
    vector[String(index)] = 1 + Math.log(count);
  }
  return vector;
}

/** Picks the most frequent terms across the whole corpus, capped for a usable vocabulary. */
export function buildVocabulary(documents: string[][], limit = 4000): string[] {
  const counts = new Map<string, number>();
  for (const tokens of documents) {
    for (const token of new Set(tokens)) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

/** Cosine similarity between two sparse vectors sharing a vocabulary. */
export function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [key, value] of Object.entries(a)) {
    normA += value * value;
    const other = b[key];
    if (other) dot += value * other;
  }
  for (const value of Object.values(b)) normB += value * value;

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface MarkdownFile {
  docId: string;
  title: string;
  markdown: string;
}

/** Reads every markdown file in a directory. Non-recursive on purpose: one flat corpus. */
export function readMarkdownDirectory(dir: string): MarkdownFile[] {
  return readdirSync(dir)
    .filter((name) => extname(name).toLowerCase() === ".md")
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const markdown = readFileSync(path, "utf8");
      const titleMatch = /^#\s+(.*)$/m.exec(markdown);
      return {
        docId: name.replace(/\.md$/i, ""),
        title: titleMatch ? titleMatch[1].trim() : name.replace(/\.md$/i, ""),
        markdown,
      };
    })
    .filter((doc) => statSync(join(dir, `${doc.docId}.md`)).size > 0);
}

/** Builds the full index from parsed markdown files. */
export function buildIndex(files: MarkdownFile[], now = new Date()): DocIndex {
  const split = files.flatMap((file) => chunkMarkdown(file.title, file.markdown).map((chunk) => ({ ...chunk, docId: file.docId })));
  const vocabulary = buildVocabulary(split.map((chunk) => tokenize(`${chunk.heading} ${chunk.text}`)));

  const chunks: DocChunk[] = split.map((chunk, index) => ({
    id: `${chunk.docId}#${index}`,
    docId: chunk.docId,
    title: files.find((f) => f.docId === chunk.docId)?.title ?? chunk.docId,
    heading: chunk.heading,
    text: chunk.text,
    vector: buildVector(tokenize(`${chunk.heading} ${chunk.text}`), vocabulary),
  }));

  return { version: 1, generatedAt: now.toISOString(), vocabulary, chunks };
}

export interface SearchHit {
  chunk: DocChunk;
  score: number;
}

/** Returns the highest-scoring chunks above a similarity floor. */
export function queryIndex(index: DocIndex, question: string, limit = 3, floor = 0.05): SearchHit[] {
  const queryVector = buildVector(tokenize(question), index.vocabulary);
  return index.chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, chunk.vector) }))
    .filter((hit) => hit.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}