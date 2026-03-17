import { combinePermissions, kbPlatformPreset, defineCommand, useConfig as useConfig$1, usePlatform, useLoader, useLLM } from '@kb-labs/sdk';
import { readFile } from 'fs/promises';
import * as path2 from 'path';
import { join } from 'path';
import { loadManifest, MindEngine } from '@kb-labs/mind-engine';
import { createHash } from 'crypto';
import { isAgentError, createAgentQueryOrchestrator } from '@kb-labs/mind-orchestrator';
import { defaultMindSyncConfig } from '@kb-labs/mind-contracts';
import { z } from 'zod';
import { initMindStructure } from '@kb-labs/mind-indexer';
import { promises } from 'fs';

// src/manifest.v3.ts
var pluginPermissions = combinePermissions().with(kbPlatformPreset).withEnv([
  "NODE_ENV",
  "OPENAI_API_KEY",
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "EMBEDDING_PROVIDER",
  "VECTOR_STORE_TYPE"
]).withFs({
  mode: "readWrite",
  allow: [
    ".kb/mind/**",
    // Mind index data
    ".kb/cache/**"
    // Cache directory
  ]
}).withFs({
  mode: "read",
  allow: [
    "package.json",
    "**/package.json",
    "config/**",
    "**/*.ts",
    "**/*.tsx",
    "**/*.js",
    "**/*.jsx",
    "**/*.md"
  ]
}).withNetwork({
  fetch: [
    "https://api.openai.com/*",
    // OpenAI embeddings/LLM
    "http://localhost:6333/*",
    // Qdrant vector store (local)
    "http://127.0.0.1:6333/*",
    "https://*.qdrant.io/*"
    // Qdrant cloud
  ]
}).withPlatform({
  llm: true,
  // LLM for query orchestration
  embeddings: true,
  // Embedding generation
  vectorStore: { collections: ["mind:"] },
  // Vector DB with mind: namespace
  cache: true,
  // State caching
  analytics: true,
  // Analytics tracking
  storage: true
  // Artifact storage
}).withQuotas({
  timeoutMs: 12e5,
  // 20 minutes for indexing
  memoryMb: 4096,
  // 4GB for large codebases
  cpuMs: 6e5
  // 10 minutes CPU time
}).build();
var manifest = {
  schema: "kb.plugin/3",
  id: "@kb-labs/mind",
  version: "0.1.0",
  display: {
    name: "Mind",
    description: "AI-powered code search and RAG system for semantic codebase understanding.",
    tags: ["search", "rag", "ai", "semantic", "mind-index"]
  },
  // Configuration section in kb.config.json
  configSection: "mind",
  // Platform requirements
  platform: {
    requires: ["llm", "embeddings", "vectorStore", "cache", "storage"],
    optional: ["analytics", "logger"]
  },
  // ✅ PERMISSIONS DEFINED ONCE FOR ENTIRE PLUGIN (Manifest-First)
  // All commands, routes, and actions inherit these permissions
  permissions: pluginPermissions,
  // CLI commands (V3 structure with cli wrapper)
  cli: {
    commands: [
      {
        id: "mind:init",
        group: "mind",
        describe: "Initialize mind workspace",
        handler: "./cli/commands/init.js#default",
        handlerPath: "./cli/commands/init.js"
      },
      {
        id: "mind:verify",
        group: "mind",
        describe: "Verify workspace consistency",
        handler: "./cli/commands/verify.js#default",
        handlerPath: "./cli/commands/verify.js"
      },
      {
        id: "mind:rag-index",
        group: "mind",
        describe: "Build Mind indexes",
        handler: "./cli/commands/rag-index.js#default",
        handlerPath: "./cli/commands/rag-index.js"
      },
      {
        id: "mind:rag-query",
        group: "mind",
        describe: "Run semantic RAG query",
        handler: "./cli/commands/rag-query.js#default",
        handlerPath: "./cli/commands/rag-query.js"
      },
      // Sync commands (5 separate commands instead of subcommands)
      {
        id: "mind:sync-add",
        group: "mind",
        describe: "Add document to sync",
        handler: "./cli/commands/sync-add.js#default",
        handlerPath: "./cli/commands/sync-add.js"
      },
      {
        id: "mind:sync-update",
        group: "mind",
        describe: "Update synced document",
        handler: "./cli/commands/sync-update.js#default",
        handlerPath: "./cli/commands/sync-update.js"
      },
      {
        id: "mind:sync-delete",
        group: "mind",
        describe: "Delete synced document",
        handler: "./cli/commands/sync-delete.js#default",
        handlerPath: "./cli/commands/sync-delete.js"
      },
      {
        id: "mind:sync-list",
        group: "mind",
        describe: "List synced documents",
        handler: "./cli/commands/sync-list.js#default",
        handlerPath: "./cli/commands/sync-list.js"
      },
      {
        id: "mind:sync-status",
        group: "mind",
        describe: "Show sync status",
        handler: "./cli/commands/sync-status.js#default",
        handlerPath: "./cli/commands/sync-status.js"
      }
    ]
  },
  // Scheduled jobs (inherit permissions from manifest)
  actions: [
    {
      id: "auto-index",
      handler: "./handlers/auto-index.js#run",
      schedule: "0 * * * *",
      // Every hour
      description: "Automatically index Mind RAG database",
      enabled: false
      // Disabled by default
    }
  ],
  // Artifacts
  artifacts: [
    {
      id: "mind.index.json",
      pathTemplate: ".kb/mind/index/index.json",
      description: "Mind RAG index metadata."
    },
    {
      id: "mind.cache.json",
      pathTemplate: ".kb/cache/mind-*.json",
      description: "Mind query cache files."
    }
  ]
};
var MIND_PRODUCT_ID = "mind";
async function createMindRuntime(options) {
  const config = await resolveConfig(options.cwd, options.config);
  const platform = options.platform ?? usePlatform();
  const service = {
    index: async (scopeId) => {
      const scope = resolveScope(config, scopeId);
      const engine = createEngine(config, scope, options.cwd, options.runtime, platform, options.onProgress);
      await engine.init();
      const stats = await engine.index(resolveSources(config, scope), {
        scope,
        workspaceRoot: options.cwd
      });
      return stats;
    },
    query: async (queryOptions) => {
      if (queryOptions.productId && queryOptions.productId !== MIND_PRODUCT_ID) {
        throw new Error(`Unsupported productId "${queryOptions.productId}". Expected "${MIND_PRODUCT_ID}".`);
      }
      const scope = resolveScope(config, queryOptions.scopeId);
      const sources = resolveSources(config, scope);
      const engine = createEngine(config, scope, options.cwd, options.runtime, platform, options.onProgress);
      await engine.init();
      const result = await engine.query(
        {
          text: queryOptions.text,
          intent: queryOptions.intent ?? "summary",
          limit: queryOptions.limit,
          profileId: queryOptions.profileId,
          metadata: queryOptions.metadata
        },
        {
          scope,
          sources,
          workspaceRoot: options.cwd,
          limit: queryOptions.limit,
          profile: queryOptions.profileId ? { id: queryOptions.profileId } : void 0
        }
      );
      return result;
    }
  };
  return {
    service,
    config
  };
}
function createEngine(config, scope, cwd, runtime, platform, onProgress) {
  const engineConfig = resolveEngineConfig(config, scope);
  return new MindEngine(
    {
      id: engineConfig.id,
      type: engineConfig.type,
      options: {
        ...engineConfig.options ?? {},
        _runtime: runtime,
        platform: platform ?? void 0,
        onProgress
      }
    },
    {
      workspaceRoot: cwd
    }
  );
}
function resolveSources(config, scope) {
  if (!scope.sourceIds?.length) {
    return config.sources;
  }
  const selected = config.sources.filter((source) => scope.sourceIds.includes(source.id));
  if (!selected.length) {
    throw new Error(`Scope "${scope.id}" does not reference existing sources.`);
  }
  return selected;
}
function resolveScope(config, scopeId) {
  const scope = config.scopes.find((item) => item.id === scopeId);
  if (!scope) {
    throw new Error(`Scope "${scopeId}" is not defined in mind.scopes.`);
  }
  return scope;
}
function resolveEngineConfig(config, scope) {
  const engineId = scope.defaultEngine ?? config.defaults?.fallbackEngineId ?? config.engines[0]?.id;
  if (!engineId) {
    throw new Error("No engines configured in mind config.");
  }
  const engine = config.engines.find((item) => item.id === engineId);
  if (!engine) {
    throw new Error(`Engine "${engineId}" referenced by scope "${scope.id}" does not exist.`);
  }
  return engine;
}
async function resolveConfig(cwd, provided) {
  if (provided) {
    return normalizeConfig(provided);
  }
  const configPath = await findConfigPath(cwd);
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  return normalizeConfig(raw);
}
async function findConfigPath(cwd) {
  const candidates = [
    path2.resolve(cwd, ".kb/kb.config.json"),
    path2.resolve(cwd, "kb.config.json")
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
    }
  }
  throw new Error("No kb.config.json found. Expected .kb/kb.config.json or kb.config.json.");
}
function normalizeConfig(raw) {
  const data = raw;
  if (Array.isArray(data.profiles) && data.profiles.length > 0) {
    const profile = data.profiles.find((p) => p.id === "default") ?? data.profiles[0];
    const products = profile?.products;
    const mindConfig = products?.[MIND_PRODUCT_ID];
    if (!mindConfig) {
      throw new Error("Config does not contain profiles[].products.mind section.");
    }
    return validateConfig(mindConfig);
  }
  if (data.mind && typeof data.mind === "object") {
    return validateConfig(data.mind);
  }
  return validateConfig(data);
}
function validateConfig(config) {
  if (!Array.isArray(config.sources) || !Array.isArray(config.scopes) || !Array.isArray(config.engines)) {
    throw new Error("Invalid mind config: required arrays sources/scopes/engines are missing.");
  }
  return config;
}
var globalOrchestrator = null;
function getAdapterName(service, fallback) {
  if (!service) {
    return fallback;
  }
  const name = service.constructor?.name || service.name || service.id;
  if (name && name !== "Object" && name !== "Function") {
    return name;
  }
  return fallback;
}
async function runRagIndex(options) {
  const platform = options.platform ?? usePlatform();
  const adapters = {
    vectorStore: getAdapterName(platform?.vectorStore, "LocalVectorStore (fallback)"),
    embeddings: getAdapterName(platform?.embeddings, "DeterministicEmbeddings (fallback)"),
    storage: getAdapterName(platform?.storage, "MemoryStorage (fallback)"),
    llm: getAdapterName(platform?.llm, "LocalStubLLM (fallback)"),
    cache: getAdapterName(platform?.cache, "MemoryCache (fallback)")
  };
  let effectiveConfig = options.config;
  if (options.include || options.exclude) {
    let mindConfig = effectiveConfig;
    if (mindConfig?.sources && Array.isArray(mindConfig.sources)) {
      mindConfig = { ...mindConfig };
      mindConfig.sources = mindConfig.sources.map((source) => {
        const overriddenSource = { ...source };
        if (options.include) {
          overriddenSource.paths = [options.include];
        }
        if (options.exclude) {
          overriddenSource.exclude = options.exclude.split(",").map((s) => s.trim());
        }
        return overriddenSource;
      });
      effectiveConfig = mindConfig;
    }
  }
  const runtime = await createMindRuntime({
    cwd: options.cwd,
    config: effectiveConfig,
    runtime: "runtime" in options ? options.runtime : void 0,
    platform: options.platform
  });
  const allScopeIds = runtime.config.scopes?.map((scope) => scope.id) ?? [];
  if (!allScopeIds.length) {
    throw new Error("No mind scopes found. Update kb.config.json first.");
  }
  const scopeIds = options.scopeId ? allScopeIds.filter((scopeId) => scopeId === options.scopeId) : allScopeIds;
  if (!scopeIds.length) {
    throw new Error(
      `Scope "${options.scopeId}" is not defined in mind.scopes.`
    );
  }
  const originalSkipDedup = process.env.KB_SKIP_DEDUPLICATION;
  if (options.skipDeduplication) {
    process.env.KB_SKIP_DEDUPLICATION = "true";
  }
  const aggregatedStats = {
    filesDiscovered: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    chunksStored: 0,
    chunksUpdated: 0,
    chunksSkipped: 0,
    errorCount: 0,
    durationMs: 0,
    deletedFiles: 0,
    deletedChunks: 0,
    invalidChunks: 0
  };
  try {
    for (const scopeId of scopeIds) {
      const scopeStats = await runtime.service.index(scopeId);
      if (scopeStats) {
        aggregatedStats.filesDiscovered += scopeStats.filesDiscovered;
        aggregatedStats.filesProcessed += scopeStats.filesProcessed;
        aggregatedStats.filesSkipped += scopeStats.filesSkipped;
        aggregatedStats.chunksStored += scopeStats.chunksStored;
        aggregatedStats.chunksUpdated += scopeStats.chunksUpdated;
        aggregatedStats.chunksSkipped += scopeStats.chunksSkipped;
        aggregatedStats.errorCount += scopeStats.errorCount;
        aggregatedStats.durationMs += scopeStats.durationMs;
        aggregatedStats.deletedFiles = (aggregatedStats.deletedFiles ?? 0) + (scopeStats.deletedFiles ?? 0);
        aggregatedStats.deletedChunks = (aggregatedStats.deletedChunks ?? 0) + (scopeStats.deletedChunks ?? 0);
        aggregatedStats.invalidChunks = (aggregatedStats.invalidChunks ?? 0) + (scopeStats.invalidChunks ?? 0);
      }
    }
  } finally {
    if (originalSkipDedup === void 0) {
      delete process.env.KB_SKIP_DEDUPLICATION;
    } else {
      process.env.KB_SKIP_DEDUPLICATION = originalSkipDedup;
    }
  }
  if (globalOrchestrator) {
    await globalOrchestrator.invalidateCache(scopeIds);
  }
  return { scopeIds, adapters, stats: aggregatedStats };
}
async function runRagQuery(options) {
  const onProgressEvent = options.onProgress ? (event) => {
    try {
      const stageMap = {
        "using_reasoning_engine": "Using reasoning engine",
        "reasoning_completed": "Reasoning completed",
        "analyzing_query_complexity": "Analyzing query complexity",
        "query_is_simple": "Query is simple",
        "planning_query": "Planning query",
        "query_plan_generated": "Query plan generated",
        "executing_subqueries": "Executing subqueries",
        "subqueries_completed": "Subqueries completed",
        "synthesizing_context": "Synthesizing context",
        "context_synthesis_completed": "Context synthesis completed",
        "generating_embedding": "Generating embeddings",
        "performing_hybrid_search": "Performing hybrid search",
        "searching_vector_store": "Searching vector store",
        "search_completed": "Search completed",
        "applying_popularity_boost": "Applying popularity boost",
        "applying_query_pattern_boost": "Applying query pattern boost",
        "re_ranking_results": "Re-ranking results",
        "re_ranking_completed": "Re-ranking completed",
        "compression_applied": "Compression applied",
        "saving_query_history": "Saving query history"
      };
      const humanReadableStage = stageMap[event.stage] || event.stage;
      let enhancedDetails = event.details;
      if (event.metadata) {
        if (event.metadata.subqueries && Array.isArray(event.metadata.subqueries)) {
          const subqueryList = event.metadata.subqueries.slice(0, 3).join(", ");
          const count = event.metadata.subqueries.length;
          enhancedDetails = `${count} subqueries: ${subqueryList}${count > 3 ? "..." : ""}`;
        } else if (typeof event.metadata.resultCount === "number") {
          enhancedDetails = `${event.metadata.resultCount} results`;
        } else if (typeof event.metadata.chunkCount === "number") {
          enhancedDetails = `${event.metadata.chunkCount} chunks`;
        }
      }
      if (options.onProgress) {
        options.onProgress(humanReadableStage, enhancedDetails);
      }
    } catch (error) {
    }
  } : void 0;
  const originalRuntime = options.runtime;
  const wrappedRuntime = originalRuntime ? {
    ...originalRuntime,
    log: (level, message, meta) => {
      if (level === "info" || level === "debug") {
        return;
      }
      if (originalRuntime.log && (level === "warn" || level === "error")) {
        originalRuntime.log(level, message, meta);
      }
    }
  } : void 0;
  const runtime = await createMindRuntime({
    cwd: options.cwd,
    config: options.config,
    runtime: wrappedRuntime,
    onProgress: onProgressEvent,
    platform: options.platform
  });
  options.onProgress?.("Initializing Mind runtime");
  const defaultScopeId = runtime.config.scopes?.[0]?.id;
  const scopeId = options.scopeId ?? defaultScopeId;
  if (!scopeId) {
    throw new Error(
      "No mind scopes configured. Provide at least one scope in kb.config.json."
    );
  }
  options.onProgress?.("Preparing query", `scope: ${scopeId}`);
  options.onProgress?.("Searching Mind index");
  const result = await runtime.service.query({
    productId: MIND_PRODUCT_ID,
    intent: options.intent ?? "summary",
    scopeId,
    text: options.text,
    limit: options.limit,
    profileId: options.profileId
  });
  options.onProgress?.("Processing results", `${result.chunks.length} chunks found`);
  return {
    scopeId,
    result
  };
}
async function runAgentRagQuery(options) {
  const platformBroker = options.platform?.cache ? {
    get: (key) => options.platform.cache.get(key),
    set: (key, value, ttl) => options.platform.cache.set(key, value, ttl),
    delete: (key) => options.platform.cache.delete(key)
  } : void 0;
  const ragLlm = useLLM({
    execution: {
      cache: {
        mode: "prefer",
        scope: "segments"
      },
      stream: {
        mode: "prefer",
        fallbackToComplete: true
      }
    }
  });
  globalOrchestrator = createAgentQueryOrchestrator({
    llm: ragLlm,
    // Fresh LLM with analytics wrapper + cache/stream policy
    broker: options.broker ?? platformBroker,
    // Pass broker for persistent caching
    analyticsAdapter: options.platform?.analytics ?? null,
    config: {
      mode: options.mode ?? "auto",
      autoDetectComplexity: true
    }
  });
  const orchestrator = globalOrchestrator;
  const runtime = await createMindRuntime({
    cwd: options.cwd,
    config: options.config,
    runtime: options.runtime,
    platform: options.platform
  });
  const defaultScopeId = runtime.config.scopes?.[0]?.id;
  const scopeId = options.scopeId ?? defaultScopeId;
  if (!scopeId) {
    return {
      error: {
        code: "KNOWLEDGE_SCOPE_NOT_FOUND",
        message: "No mind scopes configured. Provide at least one scope in kb.config.json.",
        recoverable: false
      },
      meta: {
        schemaVersion: "agent-response-v1",
        requestId: `rq-${Date.now()}`,
        mode: options.mode ?? "auto",
        timingMs: 0,
        cached: false
      }
    };
  }
  const cacheContext = await resolveCacheContext({
    cwd: options.cwd,
    scopeId,
    config: runtime.config,
    providedIndexRevision: options.indexRevision,
    providedEngineConfigHash: options.engineConfigHash,
    providedSourcesDigest: options.sourcesDigest
  });
  const queryFn = async (queryOptions) => {
    const result = await runtime.service.query({
      productId: MIND_PRODUCT_ID,
      intent: queryOptions.intent ?? "search",
      scopeId,
      text: queryOptions.text,
      limit: queryOptions.limit,
      // Pass adaptive weights via metadata for mind-engine to use
      metadata: {
        agentMode: true,
        consumer: "agent",
        mode: options.mode ?? "auto",
        ...queryOptions.vectorWeight !== void 0 && queryOptions.keywordWeight !== void 0 ? {
          vectorWeight: queryOptions.vectorWeight,
          keywordWeight: queryOptions.keywordWeight
        } : {}
      }
    });
    return {
      chunks: result.chunks,
      metadata: result.metadata ?? {}
    };
  };
  return orchestrator.query(
    {
      cwd: options.cwd,
      scopeId,
      text: options.text,
      mode: options.mode,
      indexRevision: cacheContext.indexRevision,
      engineConfigHash: cacheContext.engineConfigHash,
      sourcesDigest: cacheContext.sourcesDigest,
      debug: options.debug
    },
    queryFn
  );
}
async function resolveCacheContext(options) {
  const manifestContext = await readCacheContextFromManifest(options.cwd, options.config, options.scopeId);
  const indexRevision = options.providedIndexRevision ?? manifestContext.indexRevision;
  const engineConfigHash = options.providedEngineConfigHash ?? manifestContext.engineConfigHash ?? computeEngineConfigHash(options.config, options.scopeId);
  const sourcesDigest = options.providedSourcesDigest ?? manifestContext.sourcesDigest;
  return {
    indexRevision,
    engineConfigHash,
    sourcesDigest
  };
}
function computeEngineConfigHash(config, scopeId) {
  const scope = Array.isArray(config?.scopes) ? config.scopes.find((item) => item?.id === scopeId) : void 0;
  const engineId = scope?.defaultEngine ?? config?.defaults?.fallbackEngineId ?? config?.engines?.[0]?.id;
  const engine = Array.isArray(config?.engines) ? config.engines.find((item) => item?.id === engineId) : void 0;
  if (!engine) {
    return void 0;
  }
  const sanitized = {
    id: engine.id,
    type: engine.type,
    options: sanitizeEngineOptionsForHash(engine.options ?? {})
  };
  return createHash("sha256").update(stableStringify(sanitized)).digest("hex");
}
async function readCacheContextFromManifest(cwd, config, scopeId) {
  const scope = Array.isArray(config?.scopes) ? config.scopes.find((item) => item?.id === scopeId) : void 0;
  const engineId = scope?.defaultEngine ?? config?.defaults?.fallbackEngineId ?? config?.engines?.[0]?.id;
  const engine = Array.isArray(config?.engines) ? config.engines.find((item) => item?.id === engineId) : void 0;
  const configuredIndexDir = typeof engine?.options?.indexDir === "string" ? engine.options.indexDir : ".kb/mind/rag";
  const candidatePaths = [
    path2.resolve(cwd, configuredIndexDir, scopeId, "manifest.json"),
    path2.resolve(cwd, configuredIndexDir, "manifest.json"),
    path2.resolve(cwd, ".kb/mind/indexes", scopeId, "manifest.json"),
    path2.resolve(cwd, ".kb/mind/rag", scopeId, "manifest.json")
  ];
  for (const manifestPath of candidatePaths) {
    try {
      const manifest2 = await loadManifest(manifestPath);
      const indexRevision = manifest2.indexRevision;
      const engineConfigHash = manifest2.engineConfigHash;
      const sourcesDigest = manifest2.sourcesDigest;
      if (typeof indexRevision !== "string" || indexRevision.length === 0) {
        throw new Error("missing indexRevision");
      }
      if (typeof engineConfigHash !== "string" || engineConfigHash.length === 0) {
        throw new Error("missing engineConfigHash");
      }
      if (typeof sourcesDigest !== "string" || sourcesDigest.length === 0) {
        throw new Error("missing sourcesDigest");
      }
      return {
        found: true,
        indexRevision,
        engineConfigHash,
        sourcesDigest
      };
    } catch (error) {
      const code = error?.code;
      if (code === "ENOENT") {
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid index manifest at ${manifestPath}: ${message}`);
    }
  }
  return { found: false };
}
function sanitizeEngineOptionsForHash(options) {
  const {
    _runtime: _runtimeIgnored,
    onProgress: _onProgressIgnored,
    platform: _platformIgnored,
    ...rest
  } = options;
  return rest;
}
function stableStringify(value) {
  return JSON.stringify(sortObjectDeep(value));
}
function sortObjectDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectDeep);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, sortObjectDeep(val)]);
    return Object.fromEntries(entries);
  }
  return value;
}
function useConfig(ctx) {
  if (!ctx.config) {
    throw new Error("Mind configuration not found in context. Ensure ctx.config is loaded.");
  }
  const config = ctx.config;
  if (!config.sources || !Array.isArray(config.sources)) {
    throw new Error("Invalid mind config: missing or invalid sources");
  }
  if (!config.scopes || !Array.isArray(config.scopes)) {
    throw new Error("Invalid mind config: missing or invalid scopes");
  }
  if (!config.engines || !Array.isArray(config.engines)) {
    throw new Error("Invalid mind config: missing or invalid engines");
  }
  return config;
}
function tryUseConfig(ctx) {
  try {
    return useConfig(ctx);
  } catch {
    return null;
  }
}
function useSyncConfig(ctx) {
  const config = useConfig(ctx);
  if (!config.sync) {
    return { ...defaultMindSyncConfig };
  }
  return config.sync;
}

// src/infra/analytics/events.ts
var ANALYTICS_PREFIX = {
  QUERY: "mind.query",
  FEED: "mind.feed",
  UPDATE: "mind.update",
  INIT: "mind.init",
  PACK: "mind.pack",
  VERIFY: "mind.verify"
};
var ANALYTICS_SUFFIX = {
  STARTED: "started",
  FINISHED: "finished"
};
var ANALYTICS_EVENTS = {
  // Query events
  QUERY_STARTED: `${ANALYTICS_PREFIX.QUERY}.${ANALYTICS_SUFFIX.STARTED}`,
  QUERY_FINISHED: `${ANALYTICS_PREFIX.QUERY}.${ANALYTICS_SUFFIX.FINISHED}`,
  // Feed events
  FEED_STARTED: `${ANALYTICS_PREFIX.FEED}.${ANALYTICS_SUFFIX.STARTED}`,
  FEED_FINISHED: `${ANALYTICS_PREFIX.FEED}.${ANALYTICS_SUFFIX.FINISHED}`,
  // Update events
  UPDATE_STARTED: `${ANALYTICS_PREFIX.UPDATE}.${ANALYTICS_SUFFIX.STARTED}`,
  UPDATE_FINISHED: `${ANALYTICS_PREFIX.UPDATE}.${ANALYTICS_SUFFIX.FINISHED}`,
  // Init events
  INIT_STARTED: `${ANALYTICS_PREFIX.INIT}.${ANALYTICS_SUFFIX.STARTED}`,
  INIT_FINISHED: `${ANALYTICS_PREFIX.INIT}.${ANALYTICS_SUFFIX.FINISHED}`,
  // Pack events
  PACK_STARTED: `${ANALYTICS_PREFIX.PACK}.${ANALYTICS_SUFFIX.STARTED}`,
  PACK_FINISHED: `${ANALYTICS_PREFIX.PACK}.${ANALYTICS_SUFFIX.FINISHED}`,
  // Verify events
  VERIFY_STARTED: `${ANALYTICS_PREFIX.VERIFY}.${ANALYTICS_SUFFIX.STARTED}`,
  VERIFY_FINISHED: `${ANALYTICS_PREFIX.VERIFY}.${ANALYTICS_SUFFIX.FINISHED}`
};
var ANALYTICS_ACTOR = {
  type: "agent",
  id: "mind-cli"
};
var InitInputSchema = z.object({
  cwd: z.string().optional(),
  force: z.boolean().optional().default(false),
  json: z.boolean().optional().default(false),
  verbose: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false)
});
var InitOutputSchema = z.object({
  ok: z.boolean(),
  mindDir: z.string(),
  cwd: z.string()
});
var UpdateInputSchema = z.object({
  cwd: z.string().optional(),
  since: z.string().optional(),
  timeBudget: z.number().optional(),
  json: z.boolean().optional().default(false),
  verbose: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false)
});
var UpdateOutputSchema = z.object({
  ok: z.boolean(),
  updated: z.number(),
  duration: z.number()
});
var PackInputSchema = z.object({
  cwd: z.string().optional(),
  intent: z.string(),
  product: z.string().optional(),
  preset: z.string().optional(),
  budget: z.number().optional(),
  withBundle: z.boolean().optional().default(false),
  out: z.string().optional(),
  seed: z.number().optional(),
  json: z.boolean().optional().default(false),
  verbose: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false)
});
var PackOutputSchema = z.object({
  ok: z.boolean(),
  packPath: z.string(),
  size: z.number()
});
var FeedInputSchema = z.object({
  cwd: z.string().optional(),
  intent: z.string().optional(),
  product: z.string().optional(),
  preset: z.string().optional(),
  budget: z.number().optional(),
  withBundle: z.boolean().optional().default(false),
  since: z.string().optional(),
  timeBudget: z.number().optional(),
  noUpdate: z.boolean().optional().default(false),
  out: z.string().optional(),
  seed: z.number().optional(),
  json: z.boolean().optional().default(false),
  verbose: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false)
});
var FeedOutputSchema = z.object({
  ok: z.boolean(),
  packPath: z.string(),
  updated: z.number(),
  duration: z.number()
});
var QueryInputSchema = z.object({
  cwd: z.string().optional(),
  query: z.enum(["impact", "scope", "exports", "externals", "chain", "meta", "docs"]),
  file: z.string().optional(),
  path: z.string().optional(),
  scope: z.string().optional(),
  product: z.string().optional(),
  tag: z.string().optional(),
  type: z.string().optional(),
  filter: z.string().optional(),
  limit: z.number().optional().default(500),
  depth: z.number().optional().default(5),
  cacheMode: z.enum(["ci", "local"]).optional().default("local"),
  cacheTtl: z.number().optional().default(60),
  noCache: z.boolean().optional().default(false),
  paths: z.enum(["id", "absolute"]).optional().default("id"),
  aiMode: z.boolean().optional().default(false),
  toon: z.boolean().optional().default(false),
  toonSidecar: z.boolean().optional().default(false),
  json: z.boolean().optional().default(false),
  compact: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false)
});
var QueryOutputSchema = z.object({
  ok: z.boolean(),
  query: z.string(),
  result: z.any(),
  toonPath: z.string().optional()
});
var VerifyInputSchema = z.object({
  cwd: z.string().optional(),
  json: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false)
});
var VerifyOutputSchema = z.object({
  ok: z.boolean(),
  consistent: z.boolean(),
  errors: z.array(z.object({
    file: z.string(),
    message: z.string()
  }))
});

// src/cli/utils.ts
var colors = {
  red: (text) => `\x1B[31m${text}\x1B[0m`,
  green: (text) => `\x1B[32m${text}\x1B[0m`,
  yellow: (text) => `\x1B[33m${text}\x1B[0m`,
  blue: (text) => `\x1B[34m${text}\x1B[0m`,
  cyan: (text) => `\x1B[36m${text}\x1B[0m`,
  gray: (text) => `\x1B[90m${text}\x1B[0m`,
  bold: (text) => `\x1B[1m${text}\x1B[0m`,
  dim: (text) => `\x1B[2m${text}\x1B[0m`
};
var safeColors = colors;
var safeSymbols = {
  check: "\u2713",
  cross: "\u2717",
  arrow: "\u2192",
  bullet: "\u2022",
  info: "\u2139",
  warning: "\u26A0",
  error: "\u2717"
};
var TimingTracker = class {
  startTime;
  constructor() {
    this.startTime = Date.now();
  }
  getElapsed() {
    return Date.now() - this.startTime;
  }
  getElapsedMs() {
    return this.getElapsed();
  }
};
function formatTiming(ms) {
  if (ms < 1e3) {
    return `${ms}ms`;
  }
  return `${(ms / 1e3).toFixed(1)}s`;
}
function box(textOrTitle, maybeLines = []) {
  const lines = Array.isArray(maybeLines) ? maybeLines : typeof maybeLines === "string" ? maybeLines.split("\n") : [];
  const rows = [textOrTitle, ...lines, ""];
  return rows.map((line) => line && line.length > 0 ? `\u2502 ${line}` : "\u2502").join("\n");
}
function keyValue(arg1, arg2) {
  const format = (key, value) => {
    const label = process.env.NO_COLOR ? key : colors.cyan(key);
    return `${label}: ${value}`;
  };
  if (typeof arg1 === "string" && arg2 !== void 0) {
    return format(arg1, arg2);
  }
  if (arg1 && typeof arg1 === "object") {
    return Object.entries(arg1).map(([key, value]) => format(key, value));
  }
  return "";
}
function createSpinner(text) {
  const frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
  let frame = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r${frames[frame]} ${text}`);
    frame = (frame + 1) % frames.length;
  }, 100);
  return {
    stop: (finalText) => {
      clearInterval(interval);
      process.stdout.write(`\r${finalText || text}
`);
    }
  };
}
var init_default = defineCommand({
  id: "mind:init",
  description: "Initialize mind workspace",
  // ❌ NO permissions here - they are in manifest.v3.ts!
  // Permissions are manifest-wide in V3
  handler: {
    async execute(ctx, input) {
      const startTime = Date.now();
      const { flags } = input;
      const cwd = flags.cwd || ctx.cwd;
      ctx.trace?.addEvent?.("mind.init.start", {
        cwd,
        command: "mind:init",
        force: flags.force
      });
      ctx.trace?.addEvent?.("mind.init.initializing", { cwd, force: flags.force });
      const mindDir = await initMindStructure({
        cwd,
        force: flags.force,
        log: (entry) => {
          if (!flags.quiet && !flags.json) {
            ctx.ui.info(`Init: ${entry.msg || entry}`);
          }
          ctx.trace?.addEvent?.("mind.init.step", { msg: entry.msg || entry });
        }
      });
      ctx.trace?.addEvent?.("mind.init.complete", {
        mindDir,
        cwd
      });
      const artifacts = [];
      const artifactPatterns = [
        { name: "Index", pattern: "index.json", description: "Main Mind index" },
        { name: "API Index", pattern: "api-index.json", description: "API index" },
        { name: "Dependencies", pattern: "deps.json", description: "Dependencies graph" },
        { name: "Recent Diff", pattern: "recent-diff.json", description: "Recent changes diff" }
      ];
      for (const { name, pattern, description } of artifactPatterns) {
        const artifactPath = join(mindDir, pattern);
        try {
          const stats = await promises.stat(artifactPath);
          artifacts.push({
            name,
            path: artifactPath,
            size: stats.size,
            modified: stats.mtime,
            description
          });
        } catch {
        }
      }
      ctx.trace?.addEvent?.("mind.init.artifacts", {
        mindDir,
        artifactsCount: artifacts.length
      });
      const timing = Date.now() - startTime;
      if (flags.json) {
        ctx.ui.info(JSON.stringify({
          ok: true,
          summary: {
            Workspace: mindDir,
            Status: "Initialized"
          },
          artifacts,
          timingMs: timing,
          data: {
            mindDir,
            cwd
          }
        }));
      } else if (!flags.quiet) {
        const artifactItems = [];
        for (const artifact of artifacts) {
          artifactItems.push(`\u2713 ${artifact.name}: ${artifact.description}`);
        }
        const sections = [
          {
            header: "Summary",
            items: [
              `Workspace: ${mindDir}`,
              `Status: Initialized`
            ]
          }
        ];
        if (artifacts.length > 0) {
          sections.push({
            header: "Created Artifacts",
            items: artifactItems
          });
        }
        ctx.ui.success("Mind workspace initialized", {
          title: "Mind Init",
          sections,
          timing
        });
      }
      return {
        exitCode: 0,
        mindDir,
        artifacts
      };
    }
  }
});
var rag_index_default = defineCommand({
  id: "mind:rag-index",
  description: "Build Mind indexes",
  handler: {
    async execute(ctx, input) {
      const startTime = Date.now();
      const { flags } = input;
      const mindConfig = await useConfig$1();
      const cwd = flags.cwd || ctx.cwd;
      const scopeId = flags.scope;
      const include = flags.include;
      const exclude = flags.exclude;
      const skipDeduplication = flags.skipDeduplication;
      const platform = usePlatform();
      const loader = !flags.quiet && !flags.json ? useLoader("Building Mind RAG index...") : null;
      loader?.start();
      try {
        const result = await runRagIndex({
          cwd,
          scopeId,
          include,
          exclude,
          skipDeduplication,
          config: mindConfig,
          platform
        });
        const timing = Date.now() - startTime;
        loader?.succeed(`Index built in ${(timing / 1e3).toFixed(1)}s`);
        platform?.analytics?.track?.("mind.rag-index", {
          scopeIds: result.scopeIds,
          stats: result.stats
        }).catch(() => {
        });
        if (flags.json) {
          ctx.ui.json({
            ok: true,
            scopes: result.scopeIds,
            stats: result.stats,
            adapters: result.adapters,
            timingMs: timing
          });
        } else if (!flags.quiet) {
          const { stats } = result;
          const percentage = stats.filesDiscovered > 0 ? (stats.filesProcessed / stats.filesDiscovered * 100).toFixed(1) : "0.0";
          const chunksPerFile = stats.filesProcessed > 0 ? (stats.chunksStored / stats.filesProcessed).toFixed(2) : "0.00";
          ctx.ui.success(
            `Indexed ${stats.filesProcessed} files, ${stats.filesSkipped} skipped, ${stats.chunksStored} chunks, deleted ${stats.deletedFiles ?? 0} files/${stats.deletedChunks ?? 0} chunks`,
            {
              title: "Mind RAG Index",
              sections: [
                {
                  header: "Files",
                  items: [
                    `Discovered: ${stats.filesDiscovered}`,
                    `Processed:  ${stats.filesProcessed} (${percentage}%)`,
                    `Skipped:    ${stats.filesSkipped}`
                  ]
                },
                {
                  header: "Chunks",
                  items: [
                    `Stored: ${stats.chunksStored}`,
                    `Updated: ${stats.chunksUpdated}`,
                    `Skipped: ${stats.chunksSkipped}`,
                    `Rate:   ${chunksPerFile}/file`
                  ]
                },
                {
                  header: "Cleanup",
                  items: [
                    `Deleted files:  ${stats.deletedFiles ?? 0}`,
                    `Deleted chunks: ${stats.deletedChunks ?? 0}`,
                    `Invalid chunks: ${stats.invalidChunks ?? 0}`
                  ]
                },
                {
                  header: "Health",
                  items: [
                    `Errors: ${stats.errorCount}`
                  ]
                }
              ],
              timing
            }
          );
        }
        return {
          exitCode: 0,
          ok: true,
          scopes: result.scopeIds,
          adapters: result.adapters
        };
      } catch (error) {
        const timing = Date.now() - startTime;
        const message = error instanceof Error ? error.message : String(error);
        loader?.fail(`Index build failed: ${message}`);
        if (flags.json) {
          ctx.ui.info(JSON.stringify({
            ok: false,
            error: message,
            timingMs: timing
          }));
        } else if (!flags.quiet) {
          ctx.ui.error(`Index build failed: ${message}`);
        }
        platform?.analytics?.track?.("mind.rag-index", {
          error: true,
          errorMessage: message,
          timingMs: timing
        }).catch(() => {
        });
        return { exitCode: 1, ok: false };
      }
    }
  }
});
var VALID_INTENTS = ["summary", "search", "similar", "nav"];
var VALID_MODES = ["instant", "auto", "thinking"];
var VALID_FORMATS = ["text", "json", "json-pretty"];
function isValidIntent(intent) {
  return VALID_INTENTS.includes(intent);
}
function isValidMode(mode) {
  return VALID_MODES.includes(mode);
}
function isValidFormat(format) {
  return VALID_FORMATS.includes(format);
}
function truncateText(text, limit) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 3)}...`;
}
var rag_query_default = defineCommand({
  id: "mind:rag-query",
  description: "Run semantic RAG query on Mind index",
  handler: {
    async execute(ctx, input) {
      const startTime = Date.now();
      const { flags } = input;
      const cwd = flags.cwd || ctx.cwd;
      const scopeId = flags.scope;
      const intent = flags.intent && isValidIntent(flags.intent) ? flags.intent : void 0;
      const text = flags.text?.trim() || "";
      const limit = flags.limit ? Math.max(1, flags.limit) : void 0;
      const profileId = flags.profile;
      const platform = usePlatform();
      const mode = flags.mode && isValidMode(flags.mode) ? flags.mode : "auto";
      let format = flags.format && isValidFormat(flags.format) ? flags.format : "text";
      if (flags.json && format === "text") {
        format = "json";
      }
      if (!text) {
        if (flags.agent) {
          console.log(JSON.stringify({
            error: {
              code: "INVALID_QUERY",
              message: 'Provide --text "<query>" to run rag:query.',
              recoverable: false
            },
            meta: {
              schemaVersion: "agent-response-v1",
              requestId: `rq-${Date.now()}`,
              mode,
              timingMs: 0,
              cached: false
            }
          }));
          ctx.trace?.addEvent?.("mind.rag-query.invalid", { reason: "missing-text" });
          return { exitCode: 1, ok: false };
        }
        ctx.ui.error('Provide --text "<query>" to run rag:query.');
        ctx.ui.info('Use: kb mind rag-query --text "your query"');
        ctx.ui.info("Add --scope to search in specific scope");
        ctx.ui.info("Add --intent to specify intent (summary, search, similar, nav)");
        ctx.trace?.addEvent?.("mind.rag-query.invalid", { reason: "missing-text" });
        return { exitCode: 1, ok: false };
      }
      if (flags.agent) {
        try {
          const result = await runAgentRagQuery({
            cwd,
            scopeId,
            text,
            mode,
            debug: flags.debug,
            broker: void 0,
            // Gracefully falls back to in-memory
            platform
            // Pass platform for analytics adapter
          });
          platform?.analytics?.track?.("mind.rag-query", {
            mode,
            agent: true,
            scopeId,
            intent
          }).catch(() => {
          });
          console.log(JSON.stringify(result));
          if (isAgentError(result)) {
            return { exitCode: 1, ok: false, result };
          }
          return { exitCode: 0, ok: true, result };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(JSON.stringify({
            error: {
              code: "ENGINE_ERROR",
              message,
              recoverable: true
            },
            meta: {
              schemaVersion: "agent-response-v1",
              requestId: `rq-${Date.now()}`,
              mode,
              timingMs: Date.now() - startTime,
              cached: false
            }
          }));
          ctx.trace?.addEvent?.("mind.rag-query.agent.error", { error: message });
          return { exitCode: 1, ok: false };
        }
      }
      if (!flags.quiet && format === "text") {
        ctx.ui.info("Initializing Mind RAG query...");
      }
      const formatElapsedTime = (ms) => {
        const seconds = Math.floor(ms / 1e3);
        if (seconds < 60) {
          return `${seconds}s`;
        }
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}m ${remainingSeconds}s`;
      };
      let currentStage = "Initializing";
      let lastProgressTime = Date.now();
      try {
        const result = await runRagQuery({
          cwd,
          scopeId,
          text,
          intent,
          limit,
          profileId,
          platform,
          // Pass platform for analytics adapter
          runtime: void 0,
          // Runtime context not available in CLI
          onProgress: (stage, details) => {
            if (flags.quiet || format === "json" || format === "json-pretty") {
              return;
            }
            currentStage = details ? `${stage}: ${details}` : stage;
            const now = Date.now();
            if (now - lastProgressTime >= 1e3) {
              const elapsed = now - startTime;
              const elapsedStr = formatElapsedTime(elapsed);
              ctx.ui.info(`${currentStage} [${elapsedStr}]`);
              lastProgressTime = now;
            }
          }
        });
        const timing = Date.now() - startTime;
        ctx.trace?.addEvent?.("mind.rag-query.complete", {
          mode,
          scopeId,
          chunks: result.result.chunks.length,
          timingMs: timing
        });
        if (format === "json" || format === "json-pretty") {
          if (result.result.metadata?.jsonResponse) {
            const jsonResponse = result.result.metadata.jsonResponse;
            if (format === "json-pretty") {
              ctx.ui.info(JSON.stringify(jsonResponse, null, 2));
            } else {
              ctx.ui.info(JSON.stringify(jsonResponse));
            }
          } else {
            ctx.ui.info(JSON.stringify({
              ok: true,
              scopeId: result.scopeId,
              intent: result.result.query.intent,
              chunks: result.result.chunks,
              contextText: result.result.contextText
            }));
          }
        } else if (!flags.quiet) {
          const topChunk = result.result.chunks[0];
          const sections = [
            {
              header: "Summary",
              items: [
                `Scope: ${result.scopeId}`,
                `Intent: ${result.result.query.intent}`,
                `Chunks returned: ${result.result.chunks.length}`
              ]
            }
          ];
          if (topChunk) {
            sections.push({
              header: "Top chunk",
              items: [
                `${topChunk.path} #${topChunk.span.startLine}-${topChunk.span.endLine}`,
                truncateText(topChunk.text, 400)
              ]
            });
          } else {
            sections.push({
              items: ["No matching chunks found."]
            });
          }
          if (result.result.contextText && result.result.contextText.length > 0) {
            const contextPreview = result.result.contextText.length > 2e3 ? result.result.contextText.substring(0, 2e3) + "..." : result.result.contextText;
            sections.push({
              header: `Synthesized context (${result.result.contextText.length} chars)`,
              items: [contextPreview]
            });
          }
          ctx.ui.success("Query completed", {
            title: "Mind RAG Query",
            sections,
            timing
          });
        }
        platform?.analytics?.track?.("mind.rag-query", {
          mode,
          agent: false,
          scopeId,
          intent
        }).catch(() => {
        });
        return { exitCode: 0, ok: true, result };
      } catch (error) {
        const timing = Date.now() - startTime;
        const message = error instanceof Error ? error.message : String(error);
        ctx.trace?.addEvent?.("mind.rag-query.error", { error: message, timingMs: timing });
        if (format === "json" || format === "json-pretty") {
          ctx.ui.info(JSON.stringify({
            ok: false,
            error: message,
            timingMs: timing
          }));
        } else if (!flags.quiet) {
          ctx.ui.error(`Query failed: ${message}`);
        }
        platform?.analytics?.track?.("mind.rag-query", {
          mode,
          agent: false,
          scopeId,
          intent,
          error: true
        }).catch(() => {
        });
        return { exitCode: 1, ok: false };
      }
    }
  }
});
var verify_default = defineCommand({
  id: "mind:verify",
  description: "Check Mind platform services readiness",
  handler: {
    async execute(ctx, input) {
      const startTime = Date.now();
      const { flags } = input;
      ctx.trace?.addEvent?.("mind.verify.start", { command: "mind:verify" });
      const platform = usePlatform();
      const services = [];
      if (!platform) {
        const result2 = {
          exitCode: 1,
          ok: false,
          services,
          issues: ["platform context is missing"],
          meta: { timingMs: Date.now() - startTime }
        };
        if (flags.json) {
          ctx.ui.info(JSON.stringify(result2));
        } else {
          ctx.ui.error("Platform services are not available in this context");
        }
        ctx.trace?.addEvent?.("mind.verify.failed", { reason: "no-platform" });
        return result2;
      }
      const check = (name, required, available, configured, message) => {
        services.push({ service: name, required, available, configured, message });
      };
      const has = (key) => Boolean(platform[key]);
      const isConfigured = (svc) => platform.isConfigured?.(svc) ?? has(svc);
      check("vectorStore", true, has("vectorStore"), isConfigured("vectorStore"));
      check("embeddings", true, has("embeddings"), isConfigured("embeddings"));
      check("llm", false, has("llm"), isConfigured("llm"));
      check("cache", false, has("cache"), true);
      check("storage", false, has("storage"), true);
      check("analytics", false, has("analytics"), true);
      const requiredOk = services.filter((s) => s.required).every((s) => s.available && s.configured);
      const issues = services.filter((s) => s.required && (!s.available || !s.configured)).map((s) => `${s.service} is missing or not configured`);
      const timing = Date.now() - startTime;
      ctx.trace?.addEvent?.("mind.verify.complete", { ok: requiredOk, issues: issues.length });
      const result = {
        exitCode: requiredOk ? 0 : 1,
        ok: requiredOk,
        services,
        issues,
        meta: { timingMs: timing }
      };
      if (flags.json) {
        ctx.ui.info(JSON.stringify(result));
      } else if (!flags.quiet) {
        const sections = [
          {
            header: "Services",
            items: services.map((s) => {
              const status = s.available && s.configured ? "\u2713" : "\u26A0";
              return `${status} ${s.service}: ${s.available ? "available" : "missing"}${s.configured ? "" : " (not configured)"}`;
            })
          }
        ];
        if (issues.length) {
          sections.push({
            header: "Issues",
            items: issues.map((i) => `\u26A0 ${i}`)
          });
        }
        if (requiredOk) {
          ctx.ui.success("Mind platform services verified", {
            title: "Mind Verify - Platform",
            sections,
            timing
          });
        } else {
          ctx.ui.error("Mind platform services have issues");
          ctx.ui.success("Verification Details", {
            title: "Mind Verify - Platform",
            sections,
            timing
          });
        }
      }
      return result;
    }
  }
});

export { ANALYTICS_ACTOR, ANALYTICS_EVENTS, ANALYTICS_PREFIX, ANALYTICS_SUFFIX, FeedInputSchema, FeedOutputSchema, InitInputSchema, InitOutputSchema, MIND_PRODUCT_ID, PackInputSchema, PackOutputSchema, QueryInputSchema, QueryOutputSchema, TimingTracker, UpdateInputSchema, UpdateOutputSchema, VerifyInputSchema, VerifyOutputSchema, box, colors, createMindRuntime, createSpinner, formatTiming, keyValue, manifest, runAgentRagQuery, init_default as runInitCommand, runRagIndex, rag_index_default as runRagIndexCommand, runRagQuery, rag_query_default as runRagQueryCommand, verify_default as runVerifyCommand, safeColors, safeSymbols, tryUseConfig, useConfig, useSyncConfig };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map