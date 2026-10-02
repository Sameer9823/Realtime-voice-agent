export type { AnySchema, StandardSchemaV1 } from "./schema-adapter.js";

export * from "./types.js";
export * from "./client.js";
export * from "./tool-loop.js";
export * from "./generate-object.js";
export * from "./generate-object-batch.js";
export * from "./stream-object.js";
export * from "./agent.js";
export * from "./session.js";
export * from "./trace.js";
export * from "./handoff.js";
export * from "./run.js";

export { openai } from "./providers/openai.js";
export type { OpenAIProviderConfig } from "./providers/openai.js";
export { anthropic } from "./providers/anthropic.js";
export { google } from "./providers/google.js";
export { groq } from "./providers/groq.js";
export type { GroqProviderConfig } from "./providers/groq.js";
export { mistral } from "./providers/mistral.js";
export type { MistralProviderConfig } from "./providers/mistral.js";
export { ollama } from "./providers/ollama.js";
export type { OllamaProviderConfig } from "./providers/ollama.js";
export { azureOpenAI } from "./providers/azure-openai.js";
export type { AzureOpenAIProviderConfig } from "./providers/azure-openai.js";
export { bedrock } from "./providers/bedrock.js";
export type { BedrockProviderConfig } from "./providers/bedrock.js";
export { createOpenAICompatibleProvider, buildOpenAIStyleProvider } from "./providers/openai-compatible.js";
export type { OpenAICompatibleConfig } from "./providers/openai-compatible.js";

export { createUsageLedger } from "./usage-ledger.js";
export type {
  UsageLedger,
  UsageLedgerOptions,
  UsageLedgerStats,
  UsageLedgerModelStats,
  UsageLedgerSnapshot,
} from "./usage-ledger.js";

export * from "./guardrails/index.js";
export * from "./resilience/index.js";

export { createWebSearchTool } from "./tools/web-search.js";
export type { WebSearchToolOptions, WebSearchProvider, WebSearchResultItem } from "./tools/web-search.js";

export { createSandbox } from "./sandbox.js";
export type { Sandbox, SandboxOptions, SandboxLanguage, SandboxRunOptions, SandboxRunResult } from "./sandbox.js";

export { createCodeExecutionTool, createSandboxTools } from "./tools/code-execution.js";
export type { CodeExecutionToolOptions } from "./tools/code-execution.js";

export { generateSpeech, transcribeAudio, createRealtimeSession } from "./voice.js";
export type {
  GenerateSpeechOptions,
  GenerateSpeechResult,
  TTSVoice,
  TTSFormat,
  TranscribeAudioOptions,
  TranscribeAudioResult,
  RealtimeSessionOptions,
  RealtimeSession,
  RealtimeEvent,
} from "./voice.js";

export { RedisSessionStore } from "./session-stores/redis.js";
export type { RedisSessionStoreOptions } from "./session-stores/redis.js";

export { SqliteSessionStore } from "./session-stores/sqlite.js";
export type { SqliteSessionStoreOptions } from "./session-stores/sqlite.js";

export { InMemoryVectorStore } from "./vector-store.js";
export type { VectorStore, VectorRecord, VectorQueryResult, VectorQueryOptions } from "./vector-store.js";

export { PineconeVectorStore } from "./vector-stores/pinecone.js";
export type { PineconeVectorStoreConfig } from "./vector-stores/pinecone.js";

export { openaiEmbeddings } from "./embeddings.js";
export type { EmbeddingProvider, OpenAIEmbeddingsConfig } from "./embeddings.js";

export { createRetrievalTool, embedChunks } from "./tools/retrieval.js";
export type { RetrievalToolOptions, RetrievedChunk } from "./tools/retrieval.js";

export { InMemoryCheckpointStore, FileCheckpointStore, findAgentByName } from "./checkpoint.js";
export type { RunCheckpoint, RunCheckpointStore } from "./checkpoint.js";

export { createMockProvider } from "./testing.js";
export type { MockProvider, MockProviderConfig, MockTurn } from "./testing.js";

export { exportRunTraceToOtel } from "./otel.js";
export type { OtelExportOptions } from "./otel.js";

export { renderTraceHTML } from "./trace-viewer.js";
export type { TraceViewerOptions } from "./trace-viewer.js";

export { createMCPClient } from "./mcp.js";
export type {
  MCPClient,
  MCPClientOptions,
  MCPTransportConfig,
  MCPStdioTransportConfig,
  MCPHttpTransportConfig,
} from "./mcp.js";

// Graph memory (Neo4j) — per-user long-term memory, feed ranking, self-correction.
// Requires the optional `neo4j-driver` peer dependency, dynamically imported
// (same pattern as RedisSessionStore/ioredis) so the rest of the SDK works fine
// without it installed.
export { enableGraphMemory } from "./graph-memory/graph-memory.js";
export type {
  GraphMemory,
  GraphMemoryOptions,
  Neo4jCreds,
  Neo4jDriver,
  Neo4jSession,
  Neo4jRecord,
  MinimalSession,
  MinimalMessage,
} from "./graph-memory/graph-memory.js";

export { chatWithMemory } from "./graph-memory/with-running-context.js";

export { createUpsertFactTool, applyRecencyDecay } from "./graph-memory/fact-lifecycle.js";
export type { UpsertFactParams, RecencyDecayOptions, RecencyDecayReport } from "./graph-memory/fact-lifecycle.js";

export { runSelfCorrection, startSelfCorrectionLoop } from "./graph-memory/self-correction.js";
export type { SelfCorrectionOptions, SelfCorrectionReport } from "./graph-memory/self-correction.js";

export { createFeedEngine } from "./graph-memory/feed-engine.js";
export type { FeedEngine, FeedEngineOptions, FeedItem, GetFeedOptions } from "./graph-memory/feed-engine.js";

export { ensureGraphConstraints, deleteUserGraph } from "./graph-memory/admin.js";
export type { DeleteUserGraphOptions, DeleteUserGraphResult } from "./graph-memory/admin.js";

export { createMetricsCollector } from "./graph-memory/metrics.js";
export type { MetricsCollector, MetricsSnapshot } from "./graph-memory/metrics.js";

export { createGraphMemoryManager } from "./graph-memory/manager.js";
export type { GraphMemoryManager, GraphMemoryManagerOptions } from "./graph-memory/manager.js";
