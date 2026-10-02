# Changelog

All notable changes to samai-sdk are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) formatting and
[Semantic Versioning](https://semver.org/).

While the project is pre-1.0, minor version bumps (0.X.0) may include
breaking changes — these are called out explicitly below. Patch versions
(0.3.X) will not.

## [Unreleased]

### Added
- Graph memory: per-user long-term memory backed by a Neo4j knowledge graph
  (`enableGraphMemory()`), with a private memory agent that writes facts via
  `upsert_fact` (timestamped, contradiction-aware — `applyRecencyDecay()`
  fades and prunes stale ones) and a background sweep that produces running
  context for the main agent (`chatWithMemory()`)
- `createGraphMemoryManager()` — shares a single Neo4j driver/connection pool
  across many users instead of one per user
- `runSelfCorrection()` / `startSelfCorrectionLoop()` — Cypher diagnostics for
  duplicate nodes, overly generic relationship types, and relationship-count
  overload, with a curator agent invoked only when there's something to fix
- `createFeedEngine()` — hybrid social-graph + interest-graph + engagement
  content ranking
- `ensureGraphConstraints()` / `deleteUserGraph()` — DB-level uniqueness
  constraints and a real right-to-be-forgotten function
- `createMetricsCollector()` — shared observability across all of the above
- `neo4j-driver` optional peer dependency (dynamically imported, same pattern
  as `ioredis`/`better-sqlite3` — the rest of the SDK is unaffected if it's
  not installed)

### Changed
-

### Fixed
-

## [0.3.1] - 2026-08-05

### Added
- Standard Schema support (valibot, etc.) across `generateObject()`,
  `streamObject()`, `createSchemaGuardrail()`, and `Agent.outputSchema`
- `docs/deployment.md` covering Node servers, Node serverless, and edge
  runtimes (Vercel Edge, Cloudflare Workers)

<!--
  Backfill the remaining historical entries below as you're able to
  reconstruct them (0.1.0 through 0.3.0), so users upgrading from an older
  version can see exactly what changed. Suggested sections per release:
  eight provider adapters, agent runtime (defineAgent/runAgent), sessions,
  guardrails package, RAG/vector search, tracing + OTel export, CLI scaffold,
  resumable/checkpointed runs, framework hooks (React/Vue/Svelte).
-->

## [0.1.0] - TBD

### Added
- Initial public release
