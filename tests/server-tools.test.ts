import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIndex, buildVocabulary, chunkMarkdown, cosineSimilarity, queryIndex, tokenize, type DocIndex } from "@/lib/tools/docs-index";
import { createLookupDocsTool, clearDocsIndexCache, formatHits } from "@/lib/tools/lookup-docs";
import { summariseResults } from "@/lib/tools/web-search";
import { createWebSearchTool } from "@/lib/tools/web-search";
import { createWeatherTool, formatForecast, geocode } from "@/lib/tools/weather";
import { TOOL_NAMES, findTool } from "@/lib/tools/registry";

/**
 * Server-side tool behaviour, with every outbound call mocked.
 *
 * The property that matters most: these run server-side and return short text the model
 * reads aloud, so they must never leak a key, a stack trace, or an upstream URL.
 */

afterEach(() => {
  vi.restoreAllMocks();
  clearDocsIndexCache();
});

/** Tokenises a document made of single words, for vocabulary tests. */
function tokenInfo(document: string): string[] {
  return tokenize(document);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("tokenize", () => {
  it("lowercases and drops punctuation", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });

  it("drops stopwords", () => {
    expect(tokenize("the quick brown fox")).toEqual(["quick", "brown", "fox"]);
  });

  it("drops single characters", () => {
    expect(tokenize("a b cd")).toEqual(["cd"]);
  });

  it("keeps digits", () => {
    expect(tokenize("rate 24000 hertz")).toContain("24000");
  });
});

describe("chunkMarkdown", () => {
  const markdown = `# Title\n\nIntro paragraph.\n\n## Section One\n\nBody of section one.\n\n## Section Two\n\nBody of section two.`;

  it("splits on headings and records which section each chunk came from", () => {
    const chunks = chunkMarkdown("Title", markdown);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.some((c) => c.heading === "Section One")).toBe(true);
    expect(chunks.some((c) => c.heading === "Section Two")).toBe(true);
  });

  it("never merges two sections into one chunk", () => {
    for (const chunk of chunkMarkdown("Title", markdown)) {
      expect(chunk.text).not.toContain("Section Two");
    }
  });

  it("skips bullet lists, which read badly aloud", () => {
    const chunks = chunkMarkdown("Title", "# T\n\n- one\n- two\n\nReal prose.");
    expect(chunks.every((c) => !c.text.startsWith("-"))).toBe(true);
  });

  it("breaks oversized sections into multiple chunks", () => {
    const long = `# T\n\n${Array.from({ length: 40 }, (_, i) => `Sentence number ${i} with a few extra words to add length.`).join("\n\n")}`;
    expect(chunkMarkdown("T", long, 200).length).toBeGreaterThan(1);
  });

  it("returns nothing for an empty document", () => {
    expect(chunkMarkdown("T", "# T\n\n")).toEqual([]);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity({ a: 1, b: 2 }, { a: 1, b: 2 })).toBeCloseTo(1);
  });

  it("is 0 for an empty vector", () => {
    expect(cosineSimilarity({}, { a: 1 })).toBe(0);
    expect(cosineSimilarity({ a: 1 }, {})).toBe(0);
  });

  it("is 0 for disjoint vectors", () => {
    expect(cosineSimilarity({ a: 1 }, { b: 1 })).toBe(0);
  });

  it("falls as more orthogonal weight is added, since cosine normalises", () => {
    // Cosine compares direction, not magnitude: adding any component the query does not have
    // lowers similarity even a little. This is what lets a long passage rank below a short
    // exact one.
    const query = { a: 1 };
    expect(cosineSimilarity(query, { a: 1, b: 0.1 })).toBeGreaterThan(cosineSimilarity(query, { a: 1, b: 5 }));
  });
});

describe("buildVocabulary", () => {
  it("ranks by document frequency, so a repeated word in one chunk counts once", () => {
    // Within a single chunk a repeated term is already captured by term frequency, so the
    // vocabulary deliberately counts documents rather than occurrences.
    const vocab = buildVocabulary([tokenize("weather weather weather rain rain sun")]);
    expect(vocab).toContain("weather");
    expect(vocab).toContain("rain");
    // All three appear in exactly one document, so the tie breaks alphabetically.
    expect(vocab[0]).toBe("rain");
  });

  it("prefers a term that appears in more documents", () => {
    const vocab = buildVocabulary([tokenize("weather rain"), tokenInfo("weather sun"), tokenize("weather snow")]);
    expect(vocab[0]).toBe("weather");
  });

  it("respects the size cap", () => {
    const vocab = buildVocabulary([tokenize(Array.from({ length: 50 }, (_, i) => `term${i}`).join(" "))], 5);
    expect(vocab.length).toBeLessThanOrEqual(5);
  });
});

describe("index build and query", () => {
  const files = [
    {
      docId: "weather-guide",
      title: "Weather Guide",
      markdown: "# Weather Guide\n\n## Rain\n\nWhen rain is forecast, bring an umbrella and waterproof shoes.\n\n## Snow\n\nSnow requires a coat, gloves, and boots with good grip.",
    },
    {
      docId: "billing",
      title: "Billing",
      markdown: "# Billing\n\n## Invoices\n\nInvoices are issued on the first of each month and emailed to the account owner.",
    },
  ];

  const index: DocIndex = buildIndex(files, new Date("2026-01-01"));

  it("indexes every section", () => {
    expect(index.chunks.length).toBeGreaterThanOrEqual(3);
  });

  it("finds the section a question is about", () => {
    // Lexical retrieval, so the question has to share words with the passage. A paraphrased
    // question ("what should I wear when it snows") finds nothing against "Snow requires a
    // coat" - the documented limitation of TF-IDF over neural embeddings.
    const hits = queryIndex(index, "does it need a coat and gloves");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.text).toContain("Snow requires");
  });

  it("does not match a paraphrase, which is the known lexical limitation", () => {
    expect(queryIndex(index, "what should I wear when it snows")).toEqual([]);
  });

  it("does not return unrelated sections first", () => {
    const hits = queryIndex(index, "when are invoices emailed");
    expect(hits[0].chunk.text).toContain("Invoices are issued");
  });

  it("returns nothing when nothing matches", () => {
    expect(queryIndex(index, "zzzz qqqq xxxx")).toEqual([]);
  });

  it("is deterministic for identical input", () => {
    const again = buildIndex(files, new Date("2026-01-01"));
    expect(again.chunks).toEqual(index.chunks);
  });

  it("records the generation timestamp", () => {
    expect(index.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("summariseResults", () => {
  it("says so when there is nothing", () => {
    expect(summariseResults([])).toMatch(/couldn't find anything/);
  });

  it("includes the title and snippet", () => {
    const out = summariseResults([{ title: "Launch date", url: "https://x.test/a", content: "It ships on Friday." }]);
    expect(out).toContain("Launch date");
    expect(out).toContain("It ships on Friday.");
  });

  it("caps the number of results", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, content: `c${i}` }));
    const out = summariseResults(many);
    // Numbered inline on one line, so count the markers rather than matching line starts.
    expect(out.match(/\d\.\sT\d/g) ?? []).toHaveLength(3);
  });

  it("truncates a long snippet", () => {
    const out = summariseResults([{ title: "T", content: "x".repeat(1000) }]);
    expect(out.length).toBeLessThan(600);
  });

  it("tolerates a result with no fields at all", () => {
    expect(() => summariseResults([{}])).not.toThrow();
  });
});

describe("createWebSearchTool", () => {
  it("returns speakable results on success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [{ title: "Result", content: "Something useful." }] }));
    const tool = createWebSearchTool({ apiKey: "tvly-test", fetchImpl: fetchImpl as unknown as typeof fetch });

    const out = await tool.execute({ query: "weather" });
    expect(out).toContain("Something useful.");
  });

  it("reports unavailability without a key instead of throwing", async () => {
    const tool = createWebSearchTool({ apiKey: undefined });
    const original = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    expect(await tool.execute({ query: "x" })).toMatch(/isn't set up/);
    if (original !== undefined) process.env.TAVILY_API_KEY = original;
  });

  it("never leaks the API key on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream detail tvly-secret-value", { status: 500 }));
    const tool = createWebSearchTool({ apiKey: "tvly-secret-value", fetchImpl: fetchImpl as unknown as typeof fetch });

    const out = await tool.execute({ query: "x" });
    expect(out).not.toContain("tvly-secret-value");
    expect(out).not.toContain("upstream detail");
  });

  it("reports a network failure as friendly text", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET at /home/user/project/api/tavily.ts:12");
    });
    const tool = createWebSearchTool({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    const out = await tool.execute({ query: "x" });
    expect(out).toMatch(/didn't respond/);
    expect(out).not.toContain("ECONNRESET");
    expect(out).not.toContain("api/tavily.ts");
  });

  it("handles an unreadable payload", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));
    const tool = createWebSearchTool({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await tool.execute({ query: "x" })).toMatch(/couldn't read/);
  });

  it("is marked read-only", () => {
    expect(createWebSearchTool().sideEffects).toBe(false);
  });
});

describe("createWeatherTool", () => {
  it("geocodes then fetches a forecast", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("geocoding")) return jsonResponse({ results: [{ name: "Lisbon", latitude: 38.7, longitude: -9.1 }] });
      // The request asks Open-Meteo for Fahrenheit, so the payload comes back already converted.
      expect(url).toContain("temperature_unit=fahrenheit");
      return jsonResponse({ current: { temperature_2m: 70, weather_code: 0 }, daily: { temperature_2m_max: [77], temperature_2m_min: [61] } });
    });

    const tool = createWeatherTool({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await tool.execute({ location: "Lisbon" });

    expect(out).toContain("Lisbon");
    expect(out).toContain("clear");
    expect(out).toContain("70 degrees Fahrenheit");
    expect(out).toContain("high 77 degrees Fahrenheit");
    expect(out).toContain("low 61 degrees Fahrenheit");
  });

  it("says so when the place is unknown", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const tool = createWeatherTool({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await tool.execute({ location: "Nowhereville" })).toMatch(/couldn't find a place/);
  });

  it("reports an upstream failure without detail", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("geocoding") ? jsonResponse({ results: [{ name: "X", latitude: 1, longitude: 2 }] }) : new Response("boom", { status: 503 }),
    );
    const tool = createWeatherTool({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await tool.execute({ location: "X" })).toMatch(/unavailable/);
  });

  it("returns null geocoding on an error status", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 500 }));
    expect(await geocode("X", fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("is marked read-only", () => {
    expect(createWeatherTool().sideEffects).toBe(false);
  });
});

describe("formatForecast", () => {
  it("describes an unknown code without crashing", () => {
    expect(formatForecast("X", { temperature_2m: 10, weather_code: 999 }, undefined, "celsius")).toContain("unsettled");
  });

  it("omits missing temperatures rather than printing undefined", () => {
    const out = formatForecast("X", undefined, undefined, "celsius");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
  });

  it("converts nothing when units match", () => {
    expect(formatForecast("X", { temperature_2m: 20 }, undefined, "celsius")).toContain("20 degrees Celsius");
  });

  it("reads temperature_2m, the field Open-Meteo actually returns", () => {
    // Guards the regression where `temperature` was read but the API sends `temperature_2m`,
    // which silently dropped the current temperature from every reply.
    expect(formatForecast("X", { temperature_2m: 18, weather_code: 3 }, undefined, "celsius")).toContain("18 degrees Celsius");
  });
});

describe("createLookupDocsTool", () => {
  const index = buildIndex(
    [
      {
        docId: "guide",
        title: "The Guide",
        markdown: "# The Guide\n\n## Setup\n\nRun the install command and then start the development server.",
      },
    ],
    new Date("2026-01-01"),
  );

  it("answers from the index and names the source", async () => {
    const tool = createLookupDocsTool({ loadIndex: () => index });
    const out = await tool.execute({ question: "how do I start the development server" });
    expect(out).toContain("The Guide");
    expect(out).toContain("development server");
  });

  it("says so when nothing matches", async () => {
    const tool = createLookupDocsTool({ loadIndex: () => index });
    expect(await tool.execute({ question: "quantum chromodynamics" })).toMatch(/couldn't find anything/);
  });

  it("reports an unreadable index without leaking a path", async () => {
    const tool = createLookupDocsTool({
      loadIndex: () => {
        throw new Error("ENOENT: D:/secret/path/content/index.json");
      },
    });
    const out = await tool.execute({ question: "anything" });
    expect(out).toMatch(/couldn't read the documentation/);
    expect(out).not.toContain("secret/path");
    expect(out).not.toContain("ENOENT");
  });

  it("caps passage length", async () => {
    const long = `# Long\n\n## Body\n\n${"word ".repeat(500)}`;
    const tool = createLookupDocsTool({ loadIndex: () => buildIndex([{ docId: "l", title: "Long", markdown: long }]), maxChars: 100 });
    const out = await tool.execute({ question: "word word word" });
    expect(out.length).toBeLessThan(600);
  });

  it("is marked read-only", () => {
    expect(createLookupDocsTool().sideEffects).toBe(false);
  });

  it("says so when the index has no chunks", async () => {
    const tool = createLookupDocsTool({ loadIndex: () => ({ version: 1, generatedAt: "", vocabulary: [], chunks: [] }) });
    expect(await tool.execute({ question: "anything at all" })).toMatch(/index is empty/);
  });
});

describe("formatHits", () => {
  it("handles an empty hit list", () => {
    expect(formatHits([], 400)).toMatch(/couldn't find anything/);
  });

  it("truncates with an ellipsis", () => {
    const hits = [{ chunk: { id: "a", docId: "d", title: "T", heading: "H", text: "y".repeat(600), vector: {} }, score: 1 }];
    expect(formatHits(hits, 50)).toContain("…");
  });
});

describe("registry", () => {
  it("exposes the three expected tools", () => {
    expect([...TOOL_NAMES].sort()).toEqual(["get_weather", "lookup_docs", "web_search"]);
  });

  it("finds a tool by wire name", () => {
    expect(findTool("get_weather")?.name).toBe("get_weather");
  });

  it("returns undefined for an unknown tool", () => {
    expect(findTool("rm_rf")).toBeUndefined();
  });
});