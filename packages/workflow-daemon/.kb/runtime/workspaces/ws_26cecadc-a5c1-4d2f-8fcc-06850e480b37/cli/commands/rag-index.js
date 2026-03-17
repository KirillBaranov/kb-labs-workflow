import { defineCommand, useConfig, usePlatform, useLoader } from '@kb-labs/sdk';
import 'crypto';
import * as path from 'path';
import { readFile } from 'fs/promises';
import { MindEngine } from '@kb-labs/mind-engine';
import '@kb-labs/mind-orchestrator';

// src/cli/commands/rag-index.ts
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
    path.resolve(cwd, ".kb/kb.config.json"),
    path.resolve(cwd, "kb.config.json")
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
  return { scopeIds, adapters, stats: aggregatedStats };
}

// src/cli/commands/rag-index.ts
var rag_index_default = defineCommand({
  id: "mind:rag-index",
  description: "Build Mind indexes",
  handler: {
    async execute(ctx, input) {
      const startTime = Date.now();
      const { flags } = input;
      const mindConfig = await useConfig();
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

export { rag_index_default as default };
//# sourceMappingURL=rag-index.js.map
//# sourceMappingURL=rag-index.js.map