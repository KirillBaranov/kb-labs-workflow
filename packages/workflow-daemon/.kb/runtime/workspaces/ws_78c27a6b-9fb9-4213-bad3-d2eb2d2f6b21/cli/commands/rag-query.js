import { defineCommand, usePlatform, useLLM } from '@kb-labs/sdk';
import { createHash } from 'crypto';
import * as path2 from 'path';
import { readFile } from 'fs/promises';
import { loadManifest, MindEngine } from '@kb-labs/mind-engine';
import { isAgentError, createAgentQueryOrchestrator } from '@kb-labs/mind-orchestrator';

// src/cli/commands/rag-query.ts
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
      const manifest = await loadManifest(manifestPath);
      const indexRevision = manifest.indexRevision;
      const engineConfigHash = manifest.engineConfigHash;
      const sourcesDigest = manifest.sourcesDigest;
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

export { rag_query_default as default };
//# sourceMappingURL=rag-query.js.map
//# sourceMappingURL=rag-query.js.map